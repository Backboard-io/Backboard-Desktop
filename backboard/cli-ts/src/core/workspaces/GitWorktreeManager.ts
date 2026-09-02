import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface GitRepositoryInfo {
	coordinatorRoot: string;
	repositoryRoot: string;
	head: string;
}

export interface EnsuredGitRepository {
	repository: GitRepositoryInfo;
	initialized: boolean;
}

export interface GitResultCommit {
	startingCommit: string;
	resultCommit: string;
	changedFiles: string[];
}

export interface GitIntegrationResult {
	status: "integrated" | "conflict";
	commit?: string;
	conflictingFiles: string[];
}

export interface GitIntegrationBatchEntry {
	startingCommit: string;
	resultCommit: string;
}

export interface GitCommandResult {
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (
	cwd: string,
	args: readonly string[],
	options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<GitCommandResult>;

// Git's linked-worktree registry is shared by every checkout of a repository.
// Concurrent `git worktree add/remove/prune` processes can observe half-written
// admin directories even when their branches and paths are disjoint. Keep only
// that small metadata phase serialized; checkout materialization happens after
// the lock and remains parallel.
const worktreeRegistryTails = new Map<string, Promise<void>>();

export class GitCommandError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly stdout: string,
		readonly stderr: string,
		readonly exitCode: number | string | undefined,
	) {
		super(message);
		this.name = "GitCommandError";
	}
}

/** Native Git worktree operations. Every invocation uses argv, never a shell. */
export class GitWorktreeManager {
	constructor(private readonly runCommand: GitCommandRunner = runGitCommand) {}

	async inspect(
		cwd: string,
		signal?: AbortSignal,
	): Promise<GitRepositoryInfo | null> {
		try {
			const coordinatorRoot = (
				await this.git(cwd, ["rev-parse", "--show-toplevel"], signal)
			).trim();
			const head = (
				await this.git(coordinatorRoot, ["rev-parse", "HEAD"], signal)
			).trim();
			const worktrees = await this.listWorktrees(coordinatorRoot, signal);
			return {
				coordinatorRoot,
				repositoryRoot: worktrees[0] ?? coordinatorRoot,
				head,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof GitCommandError) return null;
			throw error;
		}
	}

	/**
	 * Makes an arbitrary folder worktree-capable without requiring user setup.
	 * Existing repositories are never recommitted. A new or unborn repository
	 * receives one local baseline commit containing its current filesystem state.
	 */
	async ensureRepository(
		cwd: string,
		signal?: AbortSignal,
	): Promise<EnsuredGitRepository> {
		const existing = await this.inspect(cwd, signal);
		if (existing) return { repository: existing, initialized: false };

		let repositoryRoot: string;
		try {
			repositoryRoot = (
				await this.git(cwd, ["rev-parse", "--show-toplevel"], signal)
			).trim();
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!(error instanceof GitCommandError)) throw error;
			await this.git(cwd, ["init"], signal);
			repositoryRoot = (
				await this.git(cwd, ["rev-parse", "--show-toplevel"], signal)
			).trim();
		}

		try {
			await this.git(repositoryRoot, ["rev-parse", "--verify", "HEAD"], signal);
			throw new Error(
				`Git repository at ${repositoryRoot} has a HEAD commit but could not be inspected safely.`,
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!(error instanceof GitCommandError)) throw error;
		}

		await this.git(repositoryRoot, ["add", "-A", "--", "."], signal);
		await this.git(
			repositoryRoot,
			[
				"-c",
				"user.name=Backboard",
				"-c",
				"user.email=workers@backboard.local",
				"commit",
				"--allow-empty",
				"--no-gpg-sign",
				"--no-verify",
				"-m",
				"Initialize Backboard parallel workspace",
			],
			signal,
		);
		const repository = await this.inspect(repositoryRoot, signal);
		if (!repository) {
			throw new Error(
				`Backboard initialized ${repositoryRoot}, but Git did not expose a usable HEAD commit.`,
			);
		}
		return { repository, initialized: true };
	}

	async listWorktrees(
		repositoryRoot: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const output = await this.git(
			repositoryRoot,
			["worktree", "list", "--porcelain"],
			signal,
		);
		return output
			.split(/\r?\n/g)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length));
	}

	async branchExists(
		repositoryRoot: string,
		branch: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			await this.git(
				repositoryRoot,
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				signal,
			);
			return true;
		} catch (error) {
			if (error instanceof GitCommandError) return false;
			throw error;
		}
	}

	async createWorktree(input: {
		repositoryRoot: string;
		path: string;
		branch: string;
		startCommit: string;
		signal?: AbortSignal;
	}): Promise<void> {
		await withWorktreeRegistryLock(input.repositoryRoot, async () => {
			input.signal?.throwIfAborted();
			if (
				await this.branchExists(
					input.repositoryRoot,
					input.branch,
					input.signal,
				)
			) {
				throw new Error(
					`Worker branch already exists and is not owned by this worker: ${input.branch}`,
				);
			}
			if (await pathExists(input.path)) {
				throw new Error(`Worker worktree path already exists: ${input.path}`);
			}
			await this.git(
				input.repositoryRoot,
				[
					"worktree",
					"add",
					"--no-checkout",
					"--no-track",
					"-b",
					input.branch,
					input.path,
					input.startCommit,
				],
				input.signal,
			);
		});
		await this.git(
			input.path,
			["-c", "checkout.workers=0", "reset", "--hard", input.startCommit],
			input.signal,
		);
	}

	async recreateWorktree(input: {
		repositoryRoot: string;
		path: string;
		branch: string;
		signal?: AbortSignal;
	}): Promise<void> {
		if (
			!(await this.branchExists(
				input.repositoryRoot,
				input.branch,
				input.signal,
			))
		) {
			throw new Error(
				`Cannot recreate worker worktree because branch is missing: ${input.branch}`,
			);
		}
		let materialize = false;
		await withWorktreeRegistryLock(input.repositoryRoot, async () => {
			input.signal?.throwIfAborted();
			const targetPath = await canonicalPath(input.path);
			const registeredPaths = await Promise.all(
				(await this.listWorktrees(input.repositoryRoot, input.signal)).map(
					canonicalPath,
				),
			);
			const registered = registeredPaths.includes(targetPath);
			if (registered && (await pathExists(input.path))) return;

			await this.git(input.repositoryRoot, ["worktree", "prune"], input.signal);
			if (await pathExists(input.path)) {
				const entries = await readdir(input.path);
				if (entries.length > 0) {
					throw new Error(
						`Saved worker path exists outside Git's worktree registry and is not empty: ${input.path}`,
					);
				}
				await rmdir(input.path);
			}
			await this.git(
				input.repositoryRoot,
				["worktree", "add", "--no-checkout", input.path, input.branch],
				input.signal,
			);
			materialize = true;
		});
		if (materialize) {
			await this.git(
				input.path,
				["-c", "checkout.workers=0", "reset", "--hard"],
				input.signal,
			);
		}
	}

	async captureResultCommit(input: {
		worktreePath: string;
		workerId: string;
		startingCommit: string;
		signal?: AbortSignal;
	}): Promise<GitResultCommit> {
		const alreadyCaptured = await this.inspectCapturedResult(input);
		if (alreadyCaptured) return alreadyCaptured;
		const changedFiles = await this.changedFiles(
			input.worktreePath,
			input.signal,
		);
		if (changedFiles.length === 0) {
			return {
				startingCommit: input.startingCommit,
				resultCommit: input.startingCommit,
				changedFiles,
			};
		}
		const throwawayArtifacts = await this.knownThrowawayArtifacts(
			input.worktreePath,
			changedFiles,
			input.startingCommit,
			input.signal,
		);
		if (throwawayArtifacts.length > 0) {
			throw new Error(
				`Worker left temporary verification artifacts in its checkout: ${throwawayArtifacts.join(", ")}. Remove them or move them to the operating system's temporary directory before completing the worker.`,
			);
		}

		await this.git(input.worktreePath, ["add", "-A", "--", "."], input.signal);
		await this.git(
			input.worktreePath,
			[
				"-c",
				"user.name=Backboard Worker",
				"-c",
				"user.email=workers@backboard.local",
				"commit",
				"--no-gpg-sign",
				"--no-verify",
				"-m",
				`Backboard worker result\n\nBackboard-Worker: ${input.workerId}`,
			],
			input.signal,
		);
		// The result commit is the durability boundary. Once Git has created it,
		// cancellation must not prevent the small metadata reads needed to surface
		// and integrate that recoverable commit.
		const resultCommit = (
			await this.git(input.worktreePath, ["rev-parse", "HEAD"])
		).trim();
		const committedFiles = await this.changedFilesBetween(
			input.worktreePath,
			input.startingCommit,
			resultCommit,
		);
		const committedThrowawayArtifacts = await this.knownThrowawayArtifacts(
			input.worktreePath,
			committedFiles,
			input.startingCommit,
		);
		if (committedThrowawayArtifacts.length > 0) {
			throw new Error(
				`Worker left temporary verification artifacts in its checkout: ${committedThrowawayArtifacts.join(", ")}. Remove them or move them to the operating system's temporary directory before completing the worker.`,
			);
		}
		return {
			startingCommit: input.startingCommit,
			resultCommit,
			changedFiles: committedFiles,
		};
	}

	/** Finds a clean worker result whose branch advanced before metadata persisted. */
	async inspectCapturedResult(input: {
		worktreePath: string;
		startingCommit: string;
		signal?: AbortSignal;
	}): Promise<GitResultCommit | null> {
		let resultCommit: string;
		try {
			resultCommit = (
				await this.git(input.worktreePath, ["rev-parse", "HEAD"], input.signal)
			).trim();
		} catch (error) {
			if (error instanceof GitCommandError) return null;
			throw error;
		}
		if (resultCommit === input.startingCommit) return null;
		if (
			(await this.changedFiles(input.worktreePath, input.signal)).length > 0
		) {
			return null;
		}
		const changedFiles = await this.changedFilesBetween(
			input.worktreePath,
			input.startingCommit,
			resultCommit,
			input.signal,
		);
		const throwawayArtifacts = await this.knownThrowawayArtifacts(
			input.worktreePath,
			changedFiles,
			input.startingCommit,
			input.signal,
		);
		if (throwawayArtifacts.length > 0) {
			throw new Error(
				`Worker left temporary verification artifacts in its checkout: ${throwawayArtifacts.join(", ")}. Remove them or move them to the operating system's temporary directory before completing the worker.`,
			);
		}
		return { startingCommit: input.startingCommit, resultCommit, changedFiles };
	}

	async integrate(input: {
		coordinatorCwd: string;
		startingCommit: string;
		resultCommit: string;
		signal?: AbortSignal;
	}): Promise<GitIntegrationResult> {
		return this.integrateBatch({
			coordinatorCwd: input.coordinatorCwd,
			results: [
				{
					startingCommit: input.startingCommit,
					resultCommit: input.resultCommit,
				},
			],
			signal: input.signal,
		});
	}

	/** Integrates several independently captured heads in one merge commit. */
	async integrateBatch(input: {
		coordinatorCwd: string;
		results: readonly GitIntegrationBatchEntry[];
		signal?: AbortSignal;
	}): Promise<GitIntegrationResult> {
		const candidates = [
			...new Set(
				input.results
					.filter((result) => result.startingCommit !== result.resultCommit)
					.map((result) => result.resultCommit),
			),
		];
		const ancestorChecks = await Promise.all(
			candidates.map((commit) =>
				this.isAncestor(input.coordinatorCwd, commit, input.signal),
			),
		);
		const resultCommits = candidates.filter(
			(_, index) => !ancestorChecks[index],
		);
		if (resultCommits.length === 0) {
			return {
				status: "integrated",
				commit: (
					await this.git(
						input.coordinatorCwd,
						["rev-parse", "HEAD"],
						input.signal,
					)
				).trim(),
				conflictingFiles: [],
			};
		}
		if (await this.mergeInProgress(input.coordinatorCwd, input.signal)) {
			let abortedWorkerMerge = false;
			for (const resultCommit of resultCommits) {
				if (
					await this.abortWorkerIntegration(input.coordinatorCwd, resultCommit)
				) {
					abortedWorkerMerge = true;
					break;
				}
			}
			if (!abortedWorkerMerge) {
				return {
					status: "conflict",
					conflictingFiles: await this.conflictingFiles(
						input.coordinatorCwd,
						input.signal,
					),
				};
			}
		}
		const stagedFiles = await this.stagedFiles(
			input.coordinatorCwd,
			input.signal,
		);
		if (stagedFiles.length > 0) {
			throw new Error(
				`Worker integration is pending because the coordinator index contains staged changes (${stagedFiles.join(", ")}). Commit or unstage those changes, then retry; Backboard did not stash, reset, or modify them.`,
			);
		}
		const headBefore = (
			await this.git(input.coordinatorCwd, ["rev-parse", "HEAD"], input.signal)
		).trim();
		try {
			await this.git(
				input.coordinatorCwd,
				["merge", "--no-ff", "--no-commit", ...resultCommits],
				input.signal,
				{ GIT_MERGE_AUTOEDIT: "no" },
			);
			if (input.signal?.aborted) {
				await this.abortIntegration(input.coordinatorCwd, headBefore);
				throw new Error("Worker integration was cancelled before commit.");
			}
			try {
				await this.git(
					input.coordinatorCwd,
					[
						"-c",
						"user.name=Backboard Coordinator",
						"-c",
						"user.email=workers@backboard.local",
						"commit",
						"--no-edit",
						"--no-gpg-sign",
						"--no-verify",
					],
					input.signal,
				);
			} catch (error) {
				if (input.signal?.aborted) {
					await this.abortIntegration(input.coordinatorCwd, headBefore);
				}
				throw error;
			}
			if (input.signal?.aborted) {
				await this.abortIntegration(input.coordinatorCwd, headBefore);
				throw new Error(
					"Worker integration was cancelled after commit and rolled back.",
				);
			}
			return {
				status: "integrated",
				commit: (
					await this.git(
						input.coordinatorCwd,
						["rev-parse", "HEAD"],
						input.signal,
					)
				).trim(),
				conflictingFiles: [],
			};
		} catch (error) {
			if (input.signal?.aborted) {
				await this.abortIntegration(input.coordinatorCwd, headBefore);
				throw error;
			}
			const conflictingFiles = await this.conflictingFiles(
				input.coordinatorCwd,
				undefined,
			);
			if (
				conflictingFiles.length > 0 ||
				(await this.mergeInProgress(input.coordinatorCwd)) ||
				resultCommits.length > 1
			) {
				// Preserve the worker result commit, but release the coordinator from
				// this worker's failed transaction so unrelated results can integrate.
				await this.abortIntegration(input.coordinatorCwd, headBefore);
				return { status: "conflict", conflictingFiles };
			}
			throw error;
		}
	}

	private async abortIntegration(
		coordinatorCwd: string,
		headBefore: string,
	): Promise<void> {
		if (await this.mergeInProgress(coordinatorCwd)) {
			await this.git(coordinatorCwd, ["merge", "--abort"]);
			return;
		}
		const current = (
			await this.git(coordinatorCwd, ["rev-parse", "HEAD"])
		).trim();
		if (current !== headBefore) {
			// Only rolls back the just-created integration commit. --merge keeps
			// unrelated local working-tree edits intact and refuses unsafe overlap.
			await this.git(coordinatorCwd, ["reset", "--merge", headBefore]);
		}
	}

	async changedFiles(
		worktreePath: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const output = await this.git(
			worktreePath,
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			signal,
		);
		return parsePorcelainPaths(output);
	}

	/** Both sides of renames are returned so overlap locks cover every path. */
	async changedFilesBetween(
		cwd: string,
		startingCommit: string,
		resultCommit: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const output = await this.git(
			cwd,
			[
				"diff",
				"--name-only",
				"--no-renames",
				"-z",
				startingCommit,
				resultCommit,
				"--",
			],
			signal,
		);
		return [...new Set(output.split("\0").filter(Boolean))].sort();
	}

	async conflictingFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await this.git(
			cwd,
			["diff", "--name-only", "--diff-filter=U", "-z"],
			signal,
		);
		return output.split("\0").filter(Boolean).sort();
	}

	async stagedFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await this.git(
			cwd,
			["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
			signal,
		);
		return [...new Set(output.split("\0").filter(Boolean))].sort();
	}

	async mergeInProgress(cwd: string, signal?: AbortSignal): Promise<boolean> {
		try {
			await access(await this.mergeHeadPath(cwd, signal));
			return true;
		} catch (error) {
			if (
				error instanceof GitCommandError ||
				(error as { code?: string }).code === "ENOENT"
			) {
				return false;
			}
			throw error;
		}
	}

	/** Aborts only a merge containing this worker result in MERGE_HEAD. */
	async abortWorkerIntegration(
		cwd: string,
		resultCommit: string,
	): Promise<boolean> {
		if (!(await this.mergeInProgress(cwd))) return false;
		const mergeHeads = (await readFile(await this.mergeHeadPath(cwd), "utf8"))
			.split(/\s+/g)
			.filter(Boolean);
		if (!mergeHeads.includes(resultCommit)) return false;
		await this.git(cwd, ["merge", "--abort"]);
		return true;
	}

	async isAncestor(
		cwd: string,
		ancestor: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			await this.git(
				cwd,
				["merge-base", "--is-ancestor", ancestor, "HEAD"],
				signal,
			);
			return true;
		} catch (error) {
			if (error instanceof GitCommandError) return false;
			throw error;
		}
	}

	async removeCheckpointRefs(
		repositoryRoot: string,
		parentSessionId: string,
		workerId: string,
	): Promise<void> {
		const prefix = `refs/agents/${safeRefPart(parentSessionId)}/workers/${safeRefPart(workerId)}/`;
		const output = await this.git(repositoryRoot, [
			"for-each-ref",
			"--format=%(refname)",
			prefix,
		]);
		for (const ref of output.split(/\r?\n/g).filter(Boolean)) {
			await this.git(repositoryRoot, ["update-ref", "-d", ref]);
		}
	}

	/** Deletes one exact worker branch only after its result is retained by HEAD. */
	async deleteIntegratedWorkerBranch(input: {
		repositoryRoot: string;
		coordinatorCwd: string;
		branch: string;
		resultCommit: string;
	}): Promise<boolean> {
		const ref = `refs/heads/${input.branch}`;
		let current: string;
		try {
			current = (
				await this.git(input.repositoryRoot, ["rev-parse", "--verify", ref])
			).trim();
		} catch (error) {
			if (error instanceof GitCommandError) return true;
			throw error;
		}
		if (
			current !== input.resultCommit ||
			!(await this.isAncestor(input.coordinatorCwd, input.resultCommit))
		) {
			return false;
		}
		await this.git(input.repositoryRoot, [
			"update-ref",
			"-d",
			ref,
			input.resultCommit,
		]);
		return true;
	}

	async removeWorktreeIfClean(input: {
		repositoryRoot: string;
		coordinatorCwd: string;
		worktreePath: string;
		/** Refuse cleanup if the worktree moved from this exact commit. */
		expectedHead?: string;
	}): Promise<boolean> {
		const target = resolve(input.worktreePath);
		if (
			target === resolve(input.repositoryRoot) ||
			target === resolve(input.coordinatorCwd) ||
			target === resolve(dirname(input.repositoryRoot))
		) {
			throw new Error(
				`Refusing to remove a primary or coordinator worktree: ${target}`,
			);
		}
		if (!(await pathExists(target))) {
			await withWorktreeRegistryLock(input.repositoryRoot, async () =>
				this.git(input.repositoryRoot, ["worktree", "prune"]),
			);
			return true;
		}
		if (input.expectedHead) {
			const head = (await this.git(target, ["rev-parse", "HEAD"])).trim();
			if (head !== input.expectedHead) return false;
		}
		if ((await this.changedFiles(target)).length > 0) return false;
		await withWorktreeRegistryLock(input.repositoryRoot, async () =>
			this.git(input.repositoryRoot, ["worktree", "remove", target]),
		);
		return true;
	}

	private async git(
		cwd: string,
		args: readonly string[],
		signal?: AbortSignal,
		extraEnv?: NodeJS.ProcessEnv,
	): Promise<string> {
		return (
			await this.runCommand(cwd, args, {
				signal,
				env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
			})
		).stdout;
	}

	private async mergeHeadPath(
		cwd: string,
		signal?: AbortSignal,
	): Promise<string> {
		const path = (
			await this.git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"], signal)
		).trim();
		return isAbsolute(path) ? path : resolve(cwd, path);
	}

	private async knownThrowawayArtifacts(
		worktreePath: string,
		changedFiles: readonly string[],
		startingCommit: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const matches = await Promise.all(
			changedFiles.map(async (path) => {
				if (
					!THROWAWAY_ARTIFACT_PATTERNS.some((pattern) =>
						pattern.test(basename(path)),
					) ||
					!(await pathExists(join(worktreePath, path)))
				) {
					return undefined;
				}
				// Existing tracked files can legitimately have these names. Reject only
				// throwaway-looking files newly introduced by this worker result.
				const trackedAtStart = await this.git(
					worktreePath,
					["ls-tree", "-z", "--name-only", startingCommit, "--", path],
					signal,
				);
				return trackedAtStart.split("\0").includes(path) ? undefined : path;
			}),
		);
		return matches.filter((path): path is string => path !== undefined).sort();
	}
}

async function withWorktreeRegistryLock<T>(
	repositoryRoot: string,
	run: () => Promise<T>,
): Promise<T> {
	const key = resolve(repositoryRoot);
	const predecessor = worktreeRegistryTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const ticket = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	const tail = predecessor.catch(() => {}).then(() => ticket);
	worktreeRegistryTails.set(key, tail);
	await predecessor.catch(() => {});
	try {
		return await run();
	} finally {
		release();
		void tail.finally(() => {
			if (worktreeRegistryTails.get(key) === tail) {
				worktreeRegistryTails.delete(key);
			}
		});
	}
}

export function workerBranchName(
	parentSessionId: string,
	workerId: string,
): string {
	return `agent/${safeRefPart(parentSessionId)}/worker/${safeRefPart(workerId)}`;
}

export function parsePorcelainPaths(output: string): string[] {
	const entries = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		paths.push(entry.slice(3));
		if (status.includes("R") || status.includes("C")) index++;
	}
	return [...new Set(paths)].sort();
}

function safeRefPart(value: string): string {
	const safe = value
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.replace(/\.lock$/i, "-lock");
	const readable = (safe || "worker").slice(0, 80);
	if (readable === value && value.length <= 80) return readable;
	return `${readable.slice(0, 69)}-${stableNameHash(value)}`;
}

function stableNameHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
}

const THROWAWAY_ARTIFACT_PATTERNS = [
	/^\.?(?:verify|verification|scratch|tmp|temp|test[-_.]?file)(?:[-_.].*)?\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|fish|rb|php|pl|lua|ps1|jsonl?|ya?ml|toml|csv|tsv|txt|log|sql|mdx?|xml|ini|conf|cfg|env|out)$/i,
	/^\.?backboard[-_.](?:tmp|temp|verify|verification|scratch)(?:[-_.].*)?\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|fish|rb|php|pl|lua|ps1|jsonl?|ya?ml|toml|csv|tsv|txt|log|sql|mdx?|xml|ini|conf|cfg|env|out)$/i,
];

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return resolve(path);
		throw error;
	}
}

export function runGitCommand(
	cwd: string,
	args: readonly string[],
	options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<GitCommandResult> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			[...args],
			{
				cwd,
				env: options.env,
				signal: options.signal,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					const exitCode = (error as { code?: number | string }).code;
					reject(
						new GitCommandError(
							`git ${args[0] ?? "command"} failed: ${stderr.trim() || error.message}`,
							args,
							stdout,
							stderr,
							exitCode,
						),
					);
					return;
				}
				resolvePromise({ stdout, stderr });
			},
		);
	});
}
