import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	GitCommandError,
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

class CoalescingGitWorktreeManager extends GitWorktreeManager {
	readonly expectedCaptures: number;
	batchIntegrations = 0;
	private captures = 0;
	private releaseCaptures!: () => void;
	private readonly captureGate = new Promise<void>((resolve) => {
		this.releaseCaptures = resolve;
	});

	constructor(expectedCaptures: number) {
		super();
		this.expectedCaptures = expectedCaptures;
	}

	override async captureResultCommit(
		input: Parameters<GitWorktreeManager["captureResultCommit"]>[0],
	) {
		const result = await super.captureResultCommit(input);
		this.captures++;
		if (this.captures === this.expectedCaptures) this.releaseCaptures();
		await this.captureGate;
		return result;
	}

	override async integrateBatch(
		input: Parameters<GitWorktreeManager["integrateBatch"]>[0],
	) {
		if (input.results.length > 1) this.batchIntegrations++;
		return super.integrateBatch(input);
	}
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("WorkerWorkspaceManager", () => {
	it("serializes Git registry updates while materializing checkouts concurrently", async () => {
		const root = await mkdtemp(join(tmpdir(), "backboard-registry-test-"));
		roots.push(root);
		const repository = join(root, "repo");
		await mkdir(repository);
		let activeRegistry = 0;
		let maxActiveRegistry = 0;
		let activeCheckouts = 0;
		let maxActiveCheckouts = 0;
		let releaseCheckouts!: () => void;
		const checkoutGate = new Promise<void>((resolve) => {
			releaseCheckouts = resolve;
		});
		const gitManager = new GitWorktreeManager(async (_cwd, args) => {
			if (args.includes("show-ref")) {
				throw new GitCommandError("missing branch", args, "", "", 1);
			}
			if (args.includes("worktree") && args.includes("add")) {
				activeRegistry++;
				maxActiveRegistry = Math.max(maxActiveRegistry, activeRegistry);
				await Bun.sleep(15);
				activeRegistry--;
				return { stdout: "", stderr: "" };
			}
			if (args.includes("reset")) {
				activeCheckouts++;
				maxActiveCheckouts = Math.max(maxActiveCheckouts, activeCheckouts);
				if (activeCheckouts === 3) releaseCheckouts();
				await checkoutGate;
				activeCheckouts--;
			}
			return { stdout: "", stderr: "" };
		});

		await Promise.race([
			Promise.all(
				["a", "b", "c"].map((worker) =>
					gitManager.createWorktree({
						repositoryRoot: repository,
						path: join(root, `worker-${worker}`),
						branch: `agent/test/worker/${worker}`,
						startCommit: "base",
					}),
				),
			),
			Bun.sleep(1_000).then(() => {
				throw new Error("checkout materialization did not run concurrently");
			}),
		]);

		expect(maxActiveRegistry).toBe(1);
		expect(maxActiveCheckouts).toBe(3);
	});

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
			workerWorktreePath(
				fixture.repository,
				"session",
				"worker/a",
				fixture.worktreeRoot,
			),
		).not.toBe(
			workerWorktreePath(
				fixture.repository,
				"session",
				"worker a",
				fixture.worktreeRoot,
			),
		);
		const hiddenPath = workerWorktreePath(
			fixture.repository,
			"session",
			"worker-a",
			fixture.worktreeRoot,
		);
		expect(hiddenPath.startsWith(`${fixture.worktreeRoot}/`)).toBe(true);
		expect(hiddenPath).not.toContain(".backboard-workers");
		expect(hiddenPath).not.toContain(`${fixture.repository}.backboard-workers`);
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

	it("integrates three ready disjoint results in one coordinator commit", async () => {
		const fixture = await createRepository();
		const gitManager = new CoalescingGitWorktreeManager(3);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "batch-three",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});
		const countBefore = Number(
			(
				await git(fixture.repository, [
					"rev-list",
					"--count",
					"--first-parent",
					"HEAD",
				])
			).trim(),
		);
		const launch = (workerId: string, path: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "batch-three"),
				async (workspace) => {
					await writeFile(join(workspace.cwd, path), workerId, "utf8");
					return { status: "completed" };
				},
			);

		const outcomes = await Promise.all([
			launch("worker-a", "a.txt"),
			launch("worker-b", "b.txt"),
			launch("worker-c", "c.txt"),
		]);
		const countAfter = Number(
			(
				await git(fixture.repository, [
					"rev-list",
					"--count",
					"--first-parent",
					"HEAD",
				])
			).trim(),
		);

		expect(gitManager.batchIntegrations).toBe(1);
		expect(countAfter - countBefore).toBe(1);
		expect(
			outcomes.map(({ workspace }) => workspace.integrationStatus),
		).toEqual(["integrated", "integrated", "integrated"]);
		expect(await readFile(join(fixture.repository, "a.txt"), "utf8")).toBe(
			"worker-a",
		);
		expect(await readFile(join(fixture.repository, "b.txt"), "utf8")).toBe(
			"worker-b",
		);
		expect(await readFile(join(fixture.repository, "c.txt"), "utf8")).toBe(
			"worker-c",
		);
		await manager.waitForIdle();
	});

	it("shares repository inspection while keeping Git worktree registration safe", async () => {
		const fixture = await createRepository();
		const gitManager = new (class extends GitWorktreeManager {
			inspectCalls = 0;

			override async inspect(cwd: string, signal?: AbortSignal) {
				this.inspectCalls++;
				return super.inspect(cwd, signal);
			}
		})();
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "shared-inspection",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});
		let active = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launch = (workerId: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "shared-inspection"),
				async (workspace) => {
					active++;
					await gate;
					await writeFile(join(workspace.cwd, `${workerId}.txt`), workerId);
					active--;
					return { status: "completed" };
				},
			);

		const first = launch("worker-a");
		const second = launch("worker-b");
		await waitFor(() => active === 2);
		release();
		await Promise.all([first, second]);

		expect(gitManager.inspectCalls).toBe(1);
	});

	it("expires the shared repository snapshot after one launch burst", async () => {
		const fixture = await createRepository();
		const gitManager = new (class extends GitWorktreeManager {
			inspectCalls = 0;

			override async inspect(cwd: string, signal?: AbortSignal) {
				this.inspectCalls++;
				return super.inspect(cwd, signal);
			}
		})();
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "snapshot-expiry",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.runWorker(
			workerParams("worker-a", fixture.repository, "snapshot-expiry"),
			async () => ({ status: "completed" }),
		);
		await manager.runWorker(
			workerParams("worker-b", fixture.repository, "snapshot-expiry"),
			async () => ({ status: "completed" }),
		);

		expect(gitManager.inspectCalls).toBe(2);
		await manager.waitForIdle();
	});

	it("creates disjoint worker worktrees concurrently before model execution", async () => {
		const fixture = await createRepository();
		let activeCreations = 0;
		let maxActiveCreations = 0;
		const gitManager = new (class extends GitWorktreeManager {
			override async createWorktree(
				input: Parameters<GitWorktreeManager["createWorktree"]>[0],
			): Promise<void> {
				activeCreations++;
				maxActiveCreations = Math.max(maxActiveCreations, activeCreations);
				try {
					await Bun.sleep(20);
					await super.createWorktree(input);
				} finally {
					activeCreations--;
				}
			}
		})();
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "parallel-creation",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});
		const launch = (workerId: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "parallel-creation"),
				async (workspace) => {
					await writeFile(join(workspace.cwd, `${workerId}.txt`), workerId);
					return { status: "completed" };
				},
			);

		await Promise.all([
			launch("worker-a"),
			launch("worker-b"),
			launch("worker-c"),
		]);

		expect(maxActiveCreations).toBe(3);
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

	it("rolls back one worker conflict and integrates an unrelated ready result", async () => {
		const fixture = await createRepository();
		await writeFile(join(fixture.repository, "shared.txt"), "base\n", "utf8");
		await git(fixture.repository, ["add", "shared.txt"]);
		await git(fixture.repository, ["commit", "--no-gpg-sign", "-m", "shared"]);
		const manager = createManager(fixture, "isolated-conflict");
		const releases = new Map<string, () => void>();
		const gates = new Map<string, Promise<void>>();
		const started = new Set<string>();
		for (const workerId of ["worker-a", "worker-b", "worker-c"]) {
			gates.set(
				workerId,
				new Promise<void>((resolve) => {
					releases.set(workerId, resolve);
				}),
			);
		}
		const launch = (workerId: string, file: string, content: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "isolated-conflict"),
				async (workspace) => {
					started.add(workerId);
					await gates.get(workerId);
					await writeFile(join(workspace.cwd, file), content, "utf8");
					return { status: "completed" };
				},
			);

		const first = launch("worker-a", "shared.txt", "from a\n");
		const conflicted = launch("worker-b", "shared.txt", "from b\n");
		const unrelated = launch("worker-c", "unrelated.txt", "from c\n");
		await waitFor(() => started.size === 3);
		releases.get("worker-a")?.();
		expect((await first).workspace.integrationStatus).toBe("integrated");
		releases.get("worker-b")?.();
		const conflictOutcome = await conflicted;
		expect(conflictOutcome.workspace.integrationStatus).toBe("conflict");
		expect(conflictOutcome.workspace.conflictingFiles).toEqual(["shared.txt"]);
		expect(
			await new GitWorktreeManager().mergeInProgress(fixture.repository),
		).toBe(false);
		releases.get("worker-c")?.();
		const unrelatedOutcome = await unrelated;

		expect(unrelatedOutcome.workspace.integrationStatus).toBe("integrated");
		expect(
			await readFile(join(fixture.repository, "unrelated.txt"), "utf8"),
		).toBe("from c\n");
	}, 10_000);

	it("isolates one conflict after a ready batch aborts", async () => {
		const fixture = await createRepository();
		await writeFile(join(fixture.repository, "shared.txt"), "base\n", "utf8");
		await git(fixture.repository, ["add", "shared.txt"]);
		await git(fixture.repository, ["commit", "--no-gpg-sign", "-m", "shared"]);
		const gitManager = new CoalescingGitWorktreeManager(2);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "batch-conflict",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});
		let ready = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launch = (workerId: string, path: string, content: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "batch-conflict"),
				async (workspace) => {
					await writeFile(join(workspace.cwd, path), content, "utf8");
					ready++;
					await gate;
					return { status: "completed" };
				},
			);
		const conflicted = launch("worker-a", "shared.txt", "worker\n");
		const unrelated = launch("worker-b", "unrelated.txt", "unrelated\n");
		await waitFor(() => ready === 2);
		await writeFile(
			join(fixture.repository, "shared.txt"),
			"coordinator\n",
			"utf8",
		);
		await git(fixture.repository, ["add", "shared.txt"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"coordinator conflict",
		]);
		release();

		const [conflictOutcome, unrelatedOutcome] = await Promise.all([
			conflicted,
			unrelated,
		]);

		expect(gitManager.batchIntegrations).toBe(1);
		expect(conflictOutcome.workspace.integrationStatus).toBe("conflict");
		expect(unrelatedOutcome.workspace.integrationStatus).toBe("integrated");
		expect(await readFile(join(fixture.repository, "shared.txt"), "utf8")).toBe(
			"coordinator\n",
		);
		expect(
			await readFile(join(fixture.repository, "unrelated.txt"), "utf8"),
		).toBe("unrelated\n");
		expect(await gitManager.mergeInProgress(fixture.repository)).toBe(false);
		await manager.waitForIdle();
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
			worktreeRoot: fixture.worktreeRoot,
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
		await manager.waitForIdle();
		expect(await pathExists(outcome.workspace.worktreePath ?? "")).toBe(false);
		expect(manager.list()[0]?.worktreeDisposition).toBe(
			"removed_clean_terminal",
		);
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

	it("rejects known throwaway artifacts before result capture", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "artifact-guard");

		await expect(
			manager.runWorker(
				workerParams("worker-a", fixture.repository, "artifact-guard"),
				async (workspace) => {
					await writeFile(join(workspace.cwd, "result.txt"), "keep", "utf8");
					await writeFile(
						join(workspace.cwd, "testfile.txt"),
						"throwaway",
						"utf8",
					);
					return { status: "completed" };
				},
			),
		).rejects.toThrow("temporary verification artifacts");

		const failed = manager.list()[0];
		expect(failed).toMatchObject({
			executionStatus: "failed",
			integrationStatus: "skipped",
		});
		expect(failed?.changedFiles).toEqual(["result.txt", "testfile.txt"]);
		await expect(
			readFile(join(fixture.repository, "result.txt"), "utf8"),
		).rejects.toThrow();
		await expect(
			readFile(join(fixture.repository, "testfile.txt"), "utf8"),
		).rejects.toThrow();
	});

	it("rejects expanded scratch artifacts but allows an existing tracked name", async () => {
		const fixture = await createRepository();
		await writeFile(
			join(fixture.repository, "verify-data.json"),
			'{"value":1}\n',
			"utf8",
		);
		await git(fixture.repository, ["add", "verify-data.json"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"tracked verification data",
		]);
		const manager = createManager(fixture, "artifact-scope");

		const allowed = await manager.runWorker(
			workerParams("allowed", fixture.repository, "artifact-scope"),
			async (workspace) => {
				await writeFile(
					join(workspace.cwd, "verify-data.json"),
					'{"value":2}\n',
					"utf8",
				);
				return { status: "completed" };
			},
		);
		expect(allowed.workspace.integrationStatus).toBe("integrated");

		await expect(
			manager.runWorker(
				workerParams("rejected", fixture.repository, "artifact-scope"),
				async (workspace) => {
					await writeFile(
						join(workspace.cwd, "scratch-results.csv"),
						"temporary,data\n",
						"utf8",
					);
					return { status: "completed" };
				},
			),
		).rejects.toThrow("scratch-results.csv");
		expect(
			await readFile(join(fixture.repository, "verify-data.json"), "utf8"),
		).toBe('{"value":2}\n');
		await manager.waitForIdle();
	});

	it("captures both sides of a rename for integration ownership", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "rename-ownership");

		const outcome = await manager.runWorker(
			workerParams("worker-a", fixture.repository, "rename-ownership"),
			async (workspace) => {
				await rename(
					join(workspace.cwd, "base.txt"),
					join(workspace.cwd, "renamed.txt"),
				);
				return { status: "completed" };
			},
		);

		expect(outcome.workspace.changedFiles).toEqual(["base.txt", "renamed.txt"]);
		await expect(
			readFile(join(fixture.repository, "base.txt"), "utf8"),
		).rejects.toThrow();
		expect(
			await readFile(join(fixture.repository, "renamed.txt"), "utf8"),
		).toBe("base\n");
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
			autoInitializeGit: true,
			worktreeRoot: join(root, "hidden-worktrees"),
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
			autoInitializeGit: true,
			worktreeRoot: join(root, "hidden-worktrees"),
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
	}, 15_000);

	it("rejects non-Git writes by default without creating repository metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "backboard-non-git-test-"));
		roots.push(root);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "non-git",
			store: new WorkerWorkspaceStore(join(root, "state", "workers.json")),
			worktreeRoot: join(root, "hidden-worktrees"),
		});
		let ran = false;

		await expect(
			manager.runWorker(workerParams("worker-a", root, "non-git"), async () => {
				ran = true;
				return { status: "completed" };
			}),
		).rejects.toThrow("Git is required for isolated parallel writes");
		expect(ran).toBe(false);
		await expect(access(join(root, ".git"))).rejects.toThrow();
	});

	it("rejects dirty write workers without mutating user state but allows read-only work", async () => {
		const fixture = await createRepository();
		await writeFile(
			join(fixture.repository, "base.txt"),
			"dirty tracked\n",
			"utf8",
		);
		await writeFile(
			join(fixture.repository, "untracked.txt"),
			"dirty untracked\n",
			"utf8",
		);
		const manager = createManager(fixture, "dirty-routing");
		let writeRan = false;

		await expect(
			manager.runWorker(
				workerParams("write-worker", fixture.repository, "dirty-routing"),
				async () => {
					writeRan = true;
					return { status: "completed" };
				},
			),
		).rejects.toThrow("Use the main agent's direct file tools");
		expect(writeRan).toBe(false);
		expect(await readFile(join(fixture.repository, "base.txt"), "utf8")).toBe(
			"dirty tracked\n",
		);
		expect(
			await readFile(join(fixture.repository, "untracked.txt"), "utf8"),
		).toBe("dirty untracked\n");
		expect(await git(fixture.repository, ["status", "--porcelain=v1"])).toBe(
			" M base.txt\n?? untracked.txt\n",
		);

		const readOnly = await manager.runWorker(
			{
				...workerParams("read-worker", fixture.repository, "dirty-routing"),
				readOnly: true,
			},
			async (workspace) => {
				expect(workspace.cwd).toBe(fixture.repository);
				expect(await readFile(join(workspace.cwd, "base.txt"), "utf8")).toBe(
					"dirty tracked\n",
				);
				return { status: "completed" };
			},
		);
		expect(readOnly.workspace.integrationStatus).toBe("not_required");
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
		await manager.waitForIdle();
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
			await readWorkerCommitFile(fixture.repository, a.workspace, "result.txt"),
		).toBe("result from A\n");
		expect(
			await readWorkerCommitFile(fixture.repository, b.workspace, "result.txt"),
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

		await expect(
			git(fixture.repository, [
				"merge",
				"--no-ff",
				"--no-commit",
				conflicted[0]?.workspace.resultCommit ?? "",
			]),
		).rejects.toThrow();
		await git(fixture.repository, ["rm", "-f", "result.txt"]);
		await writeFile(
			join(fixture.repository, "worker-a-result.txt"),
			await readWorkerCommitFile(fixture.repository, a.workspace, "result.txt"),
		);
		await writeFile(
			join(fixture.repository, "worker-b-result.txt"),
			await readWorkerCommitFile(fixture.repository, b.workspace, "result.txt"),
		);
		await git(fixture.repository, ["add", "-A"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"Resolve worker result names",
		]);
		expect(
			await new GitWorktreeManager().isAncestor(
				fixture.repository,
				conflicted[0]?.workspace.resultCommit ?? "",
			),
		).toBe(true);
		expect(
			await new GitWorktreeManager().mergeInProgress(fixture.repository),
		).toBe(false);

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

	it("does not touch a staged coordinator index when integration must wait", async () => {
		const fixture = await createRepository();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "-b", "staged-index-worker"]);
		await writeFile(join(fixture.repository, "worker.txt"), "worker\n", "utf8");
		await git(fixture.repository, ["add", "worker.txt"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"worker result",
		]);
		const resultCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "main"]);
		await writeFile(
			join(fixture.repository, "staged.txt"),
			"user staged\n",
			"utf8",
		);
		await git(fixture.repository, ["add", "staged.txt"]);
		const headBefore = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const manager = new GitWorktreeManager();

		await expect(
			manager.integrate({
				coordinatorCwd: fixture.repository,
				startingCommit,
				resultCommit,
			}),
		).rejects.toThrow("coordinator index contains staged changes");
		expect((await git(fixture.repository, ["rev-parse", "HEAD"])).trim()).toBe(
			headBefore,
		);
		expect(
			await git(fixture.repository, ["diff", "--cached", "--name-only"]),
		).toBe("staged.txt\n");
		expect(await manager.mergeInProgress(fixture.repository)).toBe(false);
	});

	it("treats an already-integrated result commit as an idempotent success", async () => {
		const fixture = await createRepository();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "-b", "idempotent-worker"]);
		await writeFile(
			join(fixture.repository, "idempotent.txt"),
			"worker result",
			"utf8",
		);
		await git(fixture.repository, ["add", "idempotent.txt"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"idempotent result",
		]);
		const resultCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "main"]);
		const manager = new GitWorktreeManager();

		const first = await manager.integrate({
			coordinatorCwd: fixture.repository,
			startingCommit,
			resultCommit,
		});
		const second = await manager.integrate({
			coordinatorCwd: fixture.repository,
			startingCommit,
			resultCommit,
		});

		expect(first.status).toBe("integrated");
		expect(second).toEqual({
			status: "integrated",
			commit: first.commit,
			conflictingFiles: [],
		});
		expect(
			await readFile(join(fixture.repository, "idempotent.txt"), "utf8"),
		).toBe("worker result");
	});

	it("recovers pending metadata after the worker merge already committed", async () => {
		const fixture = await createRepository();
		const sessionId = "committed-before-metadata";
		const workerId = "worker-a";
		const gitManager = new GitWorktreeManager();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const branch = workerBranchName(sessionId, workerId);
		const worktreePath = workerWorktreePath(
			fixture.repository,
			sessionId,
			workerId,
			fixture.worktreeRoot,
		);
		await gitManager.createWorktree({
			repositoryRoot: fixture.repository,
			path: worktreePath,
			branch,
			startCommit: startingCommit,
		});
		await writeFile(join(worktreePath, "recovered.txt"), "recovered", "utf8");
		const captured = await gitManager.captureResultCommit({
			worktreePath,
			workerId,
			startingCommit,
		});
		await gitManager.integrate({
			coordinatorCwd: fixture.repository,
			startingCommit,
			resultCommit: captured.resultCommit,
		});
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId,
				parentSessionId: sessionId,
				coordinatorCwd: fixture.repository,
				repositoryRoot: fixture.repository,
				branch,
				worktreePath,
				worktreeDisposition: "present",
				startingCommit,
				resultCommit: captured.resultCommit,
				changedFiles: captured.changedFiles,
				executionStatus: "completed",
				integrationStatus: "pending",
				finishedAt: new Date(1).toISOString(),
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();
		expect(manager.list()[0]?.integrationStatus).toBe("integrated");
		expect(
			await readFile(join(fixture.repository, "recovered.txt"), "utf8"),
		).toBe("recovered");
		await manager.waitForIdle();
	});

	it("terminalizes interrupted read-only workers during restart recovery", async () => {
		const fixture = await createRepository();
		const sessionId = "read-only-recovery";
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId: "interrupted",
				sequence: 0,
				parentSessionId: sessionId,
				readOnly: true,
				coordinatorCwd: fixture.repository,
				executionStatus: "running",
				integrationStatus: "not_required",
			}),
			record({
				workerId: "already-complete",
				sequence: 1,
				parentSessionId: sessionId,
				readOnly: true,
				coordinatorCwd: fixture.repository,
				executionStatus: "completed",
				integrationStatus: "not_required",
				finishedAt: new Date(1).toISOString(),
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();
		const interrupted = manager
			.list()
			.find(({ workerId }) => workerId === "interrupted");
		const completed = manager
			.list()
			.find(({ workerId }) => workerId === "already-complete");
		expect(interrupted).toMatchObject({
			executionStatus: "failed",
			integrationStatus: "not_required",
		});
		expect(interrupted?.finishedAt).toBeDefined();
		expect(interrupted?.error).toContain("interrupted");
		expect(completed?.executionStatus).toBe("completed");
	});

	it("recovers a result commit created before running metadata was updated", async () => {
		const fixture = await createRepository();
		const sessionId = "captured-before-metadata";
		const workerId = "worker-a";
		const gitManager = new GitWorktreeManager();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const branch = workerBranchName(sessionId, workerId);
		const worktreePath = workerWorktreePath(
			fixture.repository,
			sessionId,
			workerId,
			fixture.worktreeRoot,
		);
		await gitManager.createWorktree({
			repositoryRoot: fixture.repository,
			path: worktreePath,
			branch,
			startCommit: startingCommit,
		});
		await writeFile(
			join(worktreePath, "crash-recovered.txt"),
			"recovered",
			"utf8",
		);
		const captured = await gitManager.captureResultCommit({
			worktreePath,
			workerId,
			startingCommit,
		});
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId,
				parentSessionId: sessionId,
				coordinatorCwd: fixture.repository,
				repositoryRoot: fixture.repository,
				branch,
				worktreePath,
				worktreeDisposition: "present",
				startingCommit,
				executionStatus: "running",
				integrationStatus: "pending",
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();
		const recovered = manager.list()[0];
		expect(recovered).toMatchObject({
			executionStatus: "completed",
			integrationStatus: "integrated",
			resultCommit: captured.resultCommit,
			changedFiles: ["crash-recovered.txt"],
		});
		expect(
			await readFile(join(fixture.repository, "crash-recovered.txt"), "utf8"),
		).toBe("recovered");
		await manager.waitForIdle();
	});

	it("batch integrates all ready recovered results in one restart commit", async () => {
		const fixture = await createRepository();
		const sessionId = "restart-batch";
		const gitManager = new (class extends GitWorktreeManager {
			batchIntegrations = 0;

			override async integrateBatch(
				input: Parameters<GitWorktreeManager["integrateBatch"]>[0],
			) {
				this.batchIntegrations++;
				return super.integrateBatch(input);
			}
		})();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const records: WorkerWorkspaceRecord[] = [];
		for (const [sequence, workerId] of [
			"worker-a",
			"worker-b",
			"worker-c",
		].entries()) {
			const branch = workerBranchName(sessionId, workerId);
			const worktreePath = workerWorktreePath(
				fixture.repository,
				sessionId,
				workerId,
				fixture.worktreeRoot,
			);
			await gitManager.createWorktree({
				repositoryRoot: fixture.repository,
				path: worktreePath,
				branch,
				startCommit: startingCommit,
			});
			await writeFile(join(worktreePath, `${workerId}.txt`), workerId, "utf8");
			const captured = await gitManager.captureResultCommit({
				worktreePath,
				workerId,
				startingCommit,
			});
			records.push(
				record({
					workerId,
					sequence,
					parentSessionId: sessionId,
					coordinatorCwd: fixture.repository,
					repositoryRoot: fixture.repository,
					branch,
					worktreePath,
					worktreeDisposition: "present",
					startingCommit,
					resultCommit: captured.resultCommit,
					changedFiles: captured.changedFiles,
					executionStatus: "completed",
					integrationStatus: "pending",
					finishedAt: new Date(sequence + 1).toISOString(),
				}),
			);
		}
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace(records);
		const countBefore = Number(
			(
				await git(fixture.repository, [
					"rev-list",
					"--count",
					"--first-parent",
					"HEAD",
				])
			).trim(),
		);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();
		const countAfter = Number(
			(
				await git(fixture.repository, [
					"rev-list",
					"--count",
					"--first-parent",
					"HEAD",
				])
			).trim(),
		);

		expect(gitManager.batchIntegrations).toBe(1);
		expect(countAfter - countBefore).toBe(1);
		expect(
			manager.list().map(({ integrationStatus }) => integrationStatus),
		).toEqual(["integrated", "integrated", "integrated"]);
		await manager.waitForIdle();
	});

	it("aborts and retries an interrupted multi-worker merge on restart", async () => {
		const fixture = await createRepository();
		const sessionId = "interrupted-batch";
		const gitManager = new GitWorktreeManager();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const records: WorkerWorkspaceRecord[] = [];
		for (const [sequence, workerId] of ["worker-a", "worker-b"].entries()) {
			const branch = workerBranchName(sessionId, workerId);
			const worktreePath = workerWorktreePath(
				fixture.repository,
				sessionId,
				workerId,
				fixture.worktreeRoot,
			);
			await gitManager.createWorktree({
				repositoryRoot: fixture.repository,
				path: worktreePath,
				branch,
				startCommit: startingCommit,
			});
			await writeFile(join(worktreePath, `${workerId}.txt`), workerId, "utf8");
			const captured = await gitManager.captureResultCommit({
				worktreePath,
				workerId,
				startingCommit,
			});
			records.push(
				record({
					workerId,
					sequence,
					parentSessionId: sessionId,
					coordinatorCwd: fixture.repository,
					repositoryRoot: fixture.repository,
					branch,
					worktreePath,
					worktreeDisposition: "present",
					startingCommit,
					resultCommit: captured.resultCommit,
					changedFiles: captured.changedFiles,
					executionStatus: "completed",
					integrationStatus: "integrating",
					finishedAt: new Date(sequence + 1).toISOString(),
				}),
			);
		}
		await git(fixture.repository, [
			"merge",
			"--no-ff",
			"--no-commit",
			...records.map((record) => record.resultCommit ?? ""),
		]);
		expect(await gitManager.mergeInProgress(fixture.repository)).toBe(true);
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace(records);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			git: gitManager,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();

		expect(await gitManager.mergeInProgress(fixture.repository)).toBe(false);
		expect(
			manager.list().map(({ integrationStatus }) => integrationStatus),
		).toEqual(["integrated", "integrated"]);
		expect(
			await readFile(join(fixture.repository, "worker-a.txt"), "utf8"),
		).toBe("worker-a");
		expect(
			await readFile(join(fixture.repository, "worker-b.txt"), "utf8"),
		).toBe("worker-b");
		await manager.waitForIdle();
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
			fixture.worktreeRoot,
		);
		const missingPath = workerWorktreePath(
			fixture.repository,
			"recovery",
			"missing",
			fixture.worktreeRoot,
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
			worktreeRoot: fixture.worktreeRoot,
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

	it("never recreates a legacy adjacent worker path during recovery", async () => {
		const fixture = await createRepository();
		const sessionId = "legacy-recovery";
		const workerId = "worker-a";
		const head = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
		const branch = workerBranchName(sessionId, workerId);
		await git(fixture.repository, ["branch", branch, head]);
		const legacyRoot = join(
			dirname(fixture.repository),
			`${basename(fixture.repository)}.backboard-workers`,
		);
		const legacyPath = join(legacyRoot, sessionId, workerId);
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId,
				parentSessionId: sessionId,
				coordinatorCwd: fixture.repository,
				repositoryRoot: fixture.repository,
				branch,
				worktreePath: legacyPath,
				worktreeDisposition: "present",
				startingCommit: head,
				executionStatus: "running",
				integrationStatus: "pending",
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: sessionId,
			store,
			worktreeRoot: fixture.worktreeRoot,
		});

		await manager.initialize();

		expect(manager.list()[0]?.executionStatus).toBe("failed");
		await expect(access(legacyPath)).rejects.toThrow();
		await expect(access(legacyRoot)).rejects.toThrow();
	});

	it("removes checkpoint refs before clean integrated worktrees and never targets the primary repository", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "cleanup");
		await manager.initialize();
		const checkpointRef =
			"refs/agents/cleanup/workers/clean-worker/checkpoints/turn/0";
		const outcome = await manager.runWorker(
			workerParams("clean-worker", fixture.repository, "cleanup"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "clean.txt"), "clean", "utf8");
				await git(workspace.cwd, ["update-ref", checkpointRef, "HEAD"]);
				return { status: "completed" };
			},
		);
		await manager.waitForIdle();
		const preserved = await manager.archive();
		expect(preserved).toEqual([]);
		expect(await pathExists(outcome.workspace.worktreePath ?? "")).toBe(false);
		expect(
			await branchExists(
				fixture.repository,
				outcome.workspace.branch ?? "missing-worker-branch",
			),
		).toBe(false);
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

	it("does not recreate an eagerly cleaned integrated worker", async () => {
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
		expect(await pathExists(worktreePath)).toBe(false);
		expect(restored[0]?.integrationStatus).toBe("integrated");
		expect(restored[0]?.worktreeDisposition).toBe("removed_clean_terminal");
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
			worktreeRoot: fixture.worktreeRoot,
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
			fixture.worktreeRoot,
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
			worktreeRoot: fixture.worktreeRoot,
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

	it("coalesces intermediate metadata in memory until an explicit durable flush", async () => {
		const fixture = await createRepository();
		const store = new WorkerWorkspaceStore(fixture.storePath, {
			debounceMs: 60_000,
		});
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.upsert(record({ workerId: `worker-${index}`, sequence: index }), {
					durable: false,
				}),
			),
		);

		expect(await pathExists(fixture.storePath)).toBe(false);
		expect(await store.load()).toHaveLength(20);
		await store.flush();
		const persisted = JSON.parse(await readFile(fixture.storePath, "utf8")) as {
			workers: WorkerWorkspaceRecord[];
		};
		expect(persisted.workers).toHaveLength(20);
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
		worktreeRoot: fixture.worktreeRoot,
	});
}

interface RepositoryFixture {
	root: string;
	repository: string;
	storePath: string;
	worktreeRoot: string;
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
	return {
		root,
		repository,
		storePath: join(root, "state", "workers.json"),
		worktreeRoot: join(root, "hidden-worktrees"),
	};
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return result.stdout;
}

async function readWorkerCommitFile(
	repository: string,
	workspace: WorkerWorkspaceRecord,
	path: string,
): Promise<string> {
	if (!workspace.resultCommit) {
		throw new Error(`Worker ${workspace.workerId} has no result commit`);
	}
	return git(repository, ["show", `${workspace.resultCommit}:${path}`]);
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
