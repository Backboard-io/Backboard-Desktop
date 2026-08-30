import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GitIntegrationResult,
	GitRepositoryInfo,
} from "../src/core/workspaces/GitWorktreeManager.ts";
import { GitWorktreeManager } from "../src/core/workspaces/GitWorktreeManager.ts";
import { WorkerIntegrationManager } from "../src/core/workspaces/WorkerIntegrationManager.ts";
import { WorkerWorkspaceStore } from "../src/core/workspaces/WorkerWorkspaceStore.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("WorkerIntegrationManager", () => {
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

	it("preserves the result commit and conflicting files instead of aborting the merge", async () => {
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
