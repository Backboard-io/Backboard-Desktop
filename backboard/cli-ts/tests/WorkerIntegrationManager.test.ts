import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	GitIntegrationResult,
	GitRepositoryInfo,
} from "../src/core/workspaces/GitWorktreeManager.ts";
import { GitWorktreeManager } from "../src/core/workspaces/GitWorktreeManager.ts";
import { WorkerIntegrationManager } from "../src/core/workspaces/WorkerIntegrationManager.ts";
import { WorkerWorkspaceStore } from "../src/core/workspaces/WorkerWorkspaceStore.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";
import { withPathLocks } from "../src/utils/pathLocks.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("WorkerIntegrationManager", () => {
	it("keeps an already captured worker eligible when integration is cancelled", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "unused",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);
		const abort = new AbortController();
		abort.abort();
		const result = await manager.integrate(record(), abort.signal);
		expect(result).toMatchObject({
			executionStatus: "completed",
			integrationStatus: "pending",
			resultCommit: "result",
		});
		expect(git.integrations).toEqual([]);
	});

	it("persists integrating and integrated states around a successful merge", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "merge-result",
			conflictingFiles: [],
		});
		const progress: string[] = [];
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const integrated = await manager.integrate(record(), undefined, (current) =>
			progress.push(current.integrationStatus),
		);

		expect(progress).toEqual(["integrating", "integrated"]);
		expect(integrated).toMatchObject({
			integrationStatus: "integrated",
			integrationCommit: "merge-result",
		});
		expect(git.integrations).toEqual([
			{
				coordinatorCwd: "/repo",
				startingCommit: "start",
				resultCommit: "result",
			},
		]);
		const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as {
			workers: WorkerWorkspaceRecord[];
		};
		expect(persisted.workers[0]?.integrationStatus).toBe("integrated");
	});

	it("durably records integrating before Git mutates the coordinator", async () => {
		const fixture = await createFixture();
		let markStarted!: () => void;
		const started = new Promise<void>((resolvePromise) => {
			markStarted = resolvePromise;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const git = new (class extends FakeGit {
			override async integrate(
				input: Parameters<GitWorktreeManager["integrate"]>[0],
			): Promise<GitIntegrationResult> {
				markStarted();
				await gate;
				return super.integrate(input);
			}
		})({
			status: "integrated",
			commit: "merge-result",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const operation = manager.integrate(record());
		await started;
		const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as {
			workers: WorkerWorkspaceRecord[];
		};
		expect(persisted.workers[0]?.integrationStatus).toBe("integrating");
		release();
		await operation;
	});

	it("durably marks every ready member before one disjoint Git batch", async () => {
		const fixture = await createFixture();
		let observedStatuses: string[] = [];
		const git = new (class extends FakeGit {
			override async integrateBatch(
				input: Parameters<GitWorktreeManager["integrateBatch"]>[0],
			): Promise<GitIntegrationResult> {
				const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as {
					workers: WorkerWorkspaceRecord[];
				};
				observedStatuses = persisted.workers.map(
					(worker) => worker.integrationStatus,
				);
				return super.integrateBatch(input);
			}
		})({
			status: "integrated",
			commit: "batch-merge",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);
		const records = [
			record({ workerId: "worker-a", resultCommit: "result-a" }),
			record({
				workerId: "worker-b",
				sequence: 1,
				resultCommit: "result-b",
				changedFiles: ["src/b.ts"],
			}),
			record({
				workerId: "worker-c",
				sequence: 2,
				resultCommit: "result-c",
				changedFiles: ["src/c.ts"],
			}),
		];

		const integrated = await manager.integrateBatch(records);

		expect(observedStatuses).toEqual([
			"integrating",
			"integrating",
			"integrating",
		]);
		expect(git.batchIntegrations).toHaveLength(1);
		expect(git.integrations).toEqual([]);
		expect(integrated.map((item) => item.integrationStatus)).toEqual([
			"integrated",
			"integrated",
			"integrated",
		]);
	});

	it("falls back deterministically so one batch conflict does not block unrelated results", async () => {
		const fixture = await createFixture();
		const git = new (class extends FakeGit {
			override async integrate(input: {
				coordinatorCwd: string;
				startingCommit: string;
				resultCommit: string;
			}): Promise<GitIntegrationResult> {
				this.integrations.push(input);
				return input.resultCommit === "result-a"
					? { status: "conflict", conflictingFiles: ["src/a.ts"] }
					: {
							status: "integrated",
							commit: `merge-${input.resultCommit}`,
							conflictingFiles: [],
						};
			}
		})({ status: "conflict", conflictingFiles: [] });
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const results = await manager.integrateBatch([
			record({
				workerId: "worker-a",
				resultCommit: "result-a",
				changedFiles: ["src/a.ts"],
			}),
			record({
				workerId: "worker-b",
				sequence: 1,
				resultCommit: "result-b",
				changedFiles: ["src/b.ts"],
			}),
		]);

		expect(git.batchIntegrations).toHaveLength(1);
		expect(git.integrations.map(({ resultCommit }) => resultCommit)).toEqual([
			"result-a",
			"result-b",
		]);
		expect(results.map((item) => item.integrationStatus)).toEqual([
			"conflict",
			"integrated",
		]);
	});

	it("serializes a transitive overlapping ownership group", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "merge-result",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		await manager.integrateBatch([
			record({
				workerId: "worker-a",
				resultCommit: "result-a",
				changedFiles: ["src/a.ts"],
			}),
			record({
				workerId: "worker-b",
				sequence: 1,
				resultCommit: "result-b",
				changedFiles: ["src/a.ts", "src/b.ts"],
			}),
			record({
				workerId: "worker-c",
				sequence: 2,
				resultCommit: "result-c",
				changedFiles: ["src/b.ts"],
			}),
		]);

		expect(git.batchIntegrations).toEqual([]);
		expect(git.integrations.map(({ resultCommit }) => resultCommit)).toEqual([
			"result-a",
			"result-b",
			"result-c",
		]);
	});

	it("locks only worker-owned paths while integration is in progress", async () => {
		const fixture = await createFixture();
		let markStarted!: () => void;
		const started = new Promise<void>((resolvePromise) => {
			markStarted = resolvePromise;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const git = new (class extends FakeGit {
			override async integrate(
				input: Parameters<GitWorktreeManager["integrate"]>[0],
			): Promise<GitIntegrationResult> {
				markStarted();
				await gate;
				return super.integrate(input);
			}
		})({
			status: "integrated",
			commit: "merge-result",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const integration = manager.integrate(record());
		await started;
		let overlappingEntered = false;
		const overlapping = withPathLocks(
			[resolve("/repo", "src/shared.ts")],
			async () => {
				overlappingEntered = true;
			},
		);
		await Bun.sleep(10);
		expect(overlappingEntered).toBe(false);

		let unrelatedEntered = false;
		await withPathLocks([resolve("/repo", "src/unrelated.ts")], async () => {
			unrelatedEntered = true;
		});
		expect(unrelatedEntered).toBe(true);

		release();
		await Promise.all([integration, overlapping]);
		expect(overlappingEntered).toBe(true);
	});

	it("refuses worker metadata that claims paths outside the coordinator", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "unused",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const unsafe = await manager.integrate(
			record({ changedFiles: ["../outside.ts"] }),
		);

		expect(unsafe).toMatchObject({
			integrationStatus: "skipped",
		});
		expect(unsafe.error).toContain("outside the coordinator workspace");
		expect(git.integrations).toEqual([]);
	});

	it("preserves the result commit and conflicting files for later recovery", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "conflict",
			conflictingFiles: ["src/shared.ts"],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const conflicted = await manager.integrate(record());

		expect(conflicted).toMatchObject({
			resultCommit: "result",
			integrationStatus: "conflict",
			conflictingFiles: ["src/shared.ts"],
		});
		expect(conflicted.error).toContain("src/shared.ts");
	});

	it("never invokes Git integration for failed or cancelled workers", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "unused",
			conflictingFiles: [],
		});
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const failed = await manager.integrate(
			record({ executionStatus: "failed" }),
		);
		const cancelled = await manager.integrate(
			record({ executionStatus: "cancelled" }),
		);

		expect(failed.integrationStatus).toBe("skipped");
		expect(cancelled.integrationStatus).toBe("skipped");
		expect(git.integrations).toEqual([]);
	});

	it("reconciles an interrupted integration after its result becomes an ancestor", async () => {
		const fixture = await createFixture();
		const git = new FakeGit({
			status: "integrated",
			commit: "unused",
			conflictingFiles: [],
		});
		git.ancestor = true;
		const manager = new WorkerIntegrationManager(git, fixture.store);

		const reconciled = await manager.reconcile(
			record({ integrationStatus: "integrating" }),
		);

		expect(reconciled).toMatchObject({
			integrationStatus: "integrated",
			integrationCommit: "coordinator-head",
		});
	});
});

class FakeGit extends GitWorktreeManager {
	readonly integrations: Array<{
		coordinatorCwd: string;
		startingCommit: string;
		resultCommit: string;
	}> = [];
	readonly batchIntegrations: Array<
		Parameters<GitWorktreeManager["integrateBatch"]>[0]
	> = [];
	ancestor = false;

	constructor(private readonly result: GitIntegrationResult) {
		super();
	}

	override async integrate(input: {
		coordinatorCwd: string;
		startingCommit: string;
		resultCommit: string;
		signal?: AbortSignal;
	}): Promise<GitIntegrationResult> {
		this.integrations.push({
			coordinatorCwd: input.coordinatorCwd,
			startingCommit: input.startingCommit,
			resultCommit: input.resultCommit,
		});
		return this.result;
	}

	override async integrateBatch(
		input: Parameters<GitWorktreeManager["integrateBatch"]>[0],
	): Promise<GitIntegrationResult> {
		this.batchIntegrations.push(input);
		return this.result;
	}

	override async isAncestor(): Promise<boolean> {
		return this.ancestor;
	}

	override async inspect(): Promise<GitRepositoryInfo> {
		return {
			coordinatorRoot: "/repo",
			repositoryRoot: "/repo",
			head: "coordinator-head",
		};
	}

	override async mergeInProgress(): Promise<boolean> {
		return false;
	}
}

function record(
	overrides: Partial<WorkerWorkspaceRecord> = {},
): WorkerWorkspaceRecord {
	return {
		workerId: "worker-a",
		sequence: 0,
		parentSessionId: "session",
		taskPrompt: "edit a file",
		readOnly: false,
		coordinatorCwd: "/repo",
		repositoryRoot: "/repo",
		branch: "agent/session/worker/worker-a",
		worktreePath: "/worktrees/worker-a",
		startingCommit: "start",
		resultCommit: "result",
		changedFiles: ["src/shared.ts"],
		startedAt: new Date(0).toISOString(),
		finishedAt: new Date(1).toISOString(),
		executionStatus: "completed",
		integrationStatus: "pending",
		...overrides,
	};
}

async function createFixture(): Promise<{
	path: string;
	store: WorkerWorkspaceStore;
}> {
	const root = await mkdtemp(join(tmpdir(), "worker-integration-test-"));
	roots.push(root);
	const path = join(root, "workers.json");
	return { path, store: new WorkerWorkspaceStore(path) };
}
