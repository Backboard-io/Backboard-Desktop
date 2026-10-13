import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { GitWorktreeManager } from "../src/core/workspaces/GitWorktreeManager.ts";

const execFileAsync = promisify(execFile);
const iterations = 5;
const workerCount = 3;
const serializedWorktrees: number[] = [];
const parallelWorktrees: number[] = [];
const serializedIntegrations: number[] = [];
const batchedIntegrations: number[] = [];
const serializedCommitCounts: number[] = [];
const batchedCommitCounts: number[] = [];

for (let iteration = 0; iteration < iterations; iteration++) {
	const worktreeModes =
		iteration % 2 === 0
			? (["serialized", "parallel"] as const)
			: (["parallel", "serialized"] as const);
	for (const mode of worktreeModes) {
		const elapsed = await measureWorktreeCreation(mode);
		(mode === "serialized" ? serializedWorktrees : parallelWorktrees).push(
			elapsed,
		);
	}

	const integrationModes =
		iteration % 2 === 0
			? (["serialized", "batch"] as const)
			: (["batch", "serialized"] as const);
	for (const mode of integrationModes) {
		const measured = await measureIntegration(mode);
		(mode === "serialized" ? serializedIntegrations : batchedIntegrations).push(
			measured.elapsedMs,
		);
		(mode === "serialized" ? serializedCommitCounts : batchedCommitCounts).push(
			measured.firstParentCommits,
		);
	}
}

const worktreeBefore = summarize(serializedWorktrees);
const worktreeAfter = summarize(parallelWorktrees);
const integrationBefore = summarize(serializedIntegrations);
const integrationAfter = summarize(batchedIntegrations);
console.log(
	JSON.stringify(
		{
			fixture:
				"3 disjoint write workers from one clean Git HEAD; each writes one 4 KiB file",
			iterations,
			worktreeReadyMs: {
				beforeSerialized: worktreeBefore,
				afterParallel: worktreeAfter,
				medianSpeedup: ratio(worktreeBefore.median, worktreeAfter.median),
				medianReductionPercent: reduction(
					worktreeBefore.median,
					worktreeAfter.median,
				),
			},
			integrationMs: {
				beforeThreeCommits: integrationBefore,
				afterOneBatchCommit: integrationAfter,
				medianSpeedup: ratio(integrationBefore.median, integrationAfter.median),
				medianReductionPercent: reduction(
					integrationBefore.median,
					integrationAfter.median,
				),
				beforeFirstParentCommits: serializedCommitCounts,
				afterFirstParentCommits: batchedCommitCounts,
			},
		},
		null,
		2,
	),
);

async function measureWorktreeCreation(
	mode: "serialized" | "parallel",
): Promise<number> {
	const fixture = await createRepository();
	try {
		const gitManager = new GitWorktreeManager();
		const head = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
		const operations = Array.from(
			{ length: workerCount },
			(_, index) => () =>
				gitManager.createWorktree({
					repositoryRoot: fixture.repository,
					path: join(fixture.root, "worktrees", `worker-${index}`),
					branch: `bench/worktree-${index}`,
					startCommit: head,
				}),
		);
		const startedAt = performance.now();
		if (mode === "parallel") {
			await Promise.all(operations.map((operation) => operation()));
		} else {
			for (const operation of operations) await operation();
		}
		return performance.now() - startedAt;
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
}

async function measureIntegration(
	mode: "serialized" | "batch",
): Promise<{ elapsedMs: number; firstParentCommits: number }> {
	const fixture = await createRepository();
	try {
		const gitManager = new GitWorktreeManager();
		const startingCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		const results = await Promise.all(
			Array.from({ length: workerCount }, async (_, index) => {
				const worktreePath = join(fixture.root, "worktrees", `worker-${index}`);
				await gitManager.createWorktree({
					repositoryRoot: fixture.repository,
					path: worktreePath,
					branch: `bench/integration-${index}`,
					startCommit: startingCommit,
				});
				await writeFile(
					join(worktreePath, `worker-${index}.txt`),
					`${String(index).repeat(4096)}\n`,
					"utf8",
				);
				return gitManager.captureResultCommit({
					worktreePath,
					workerId: `worker-${index}`,
					startingCommit,
				});
			}),
		);
		const countBefore = await firstParentCount(fixture.repository);
		const startedAt = performance.now();
		if (mode === "batch") {
			await gitManager.integrateBatch({
				coordinatorCwd: fixture.repository,
				results,
			});
		} else {
			for (const result of results) {
				await gitManager.integrate({
					coordinatorCwd: fixture.repository,
					startingCommit: result.startingCommit,
					resultCommit: result.resultCommit,
				});
			}
		}
		const elapsedMs = performance.now() - startedAt;
		return {
			elapsedMs,
			firstParentCommits:
				(await firstParentCount(fixture.repository)) - countBefore,
		};
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
}

async function createRepository(): Promise<{
	root: string;
	repository: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "backboard-worker-benchmark-"));
	const repository = join(root, "repo");
	await git(root, ["init", "-b", "main", repository]);
	await git(repository, ["config", "user.name", "Benchmark"]);
	await git(repository, ["config", "user.email", "benchmark@backboard.local"]);
	await writeFile(join(repository, "base.txt"), "base\n", "utf8");
	await git(repository, ["add", "base.txt"]);
	await git(repository, ["commit", "--no-gpg-sign", "-m", "baseline"]);
	return { root, repository };
}

async function firstParentCount(repository: string): Promise<number> {
	return Number(
		(
			await git(repository, ["rev-list", "--count", "--first-parent", "HEAD"])
		).trim(),
	);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await execFileAsync("git", [...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return result.stdout;
}

function summarize(samples: readonly number[]): {
	samples: number[];
	median: number;
	mean: number;
} {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		samples: samples.map(round),
		median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
		mean: round(
			samples.reduce((sum, value) => sum + value, 0) / samples.length,
		),
	};
}

function ratio(before: number, after: number): number {
	return round(after === 0 ? 0 : before / after);
}

function reduction(before: number, after: number): number {
	return round(before === 0 ? 0 : ((before - after) / before) * 100);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
