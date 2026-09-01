import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

export interface GitCommandResult {
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (
	cwd: string,
	args: readonly string[],
	options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<GitCommandResult>;

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
		if (
			await this.branchExists(input.repositoryRoot, input.branch, input.signal)
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
				"-c",
				"checkout.workers=0",
				"worktree",
				"add",
				"--no-track",
				"-b",
				input.branch,
				input.path,
				input.startCommit,
			],
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
		const registered = (
			await this.listWorktrees(input.repositoryRoot, input.signal)
		).some((path) => resolve(path) === resolve(input.path));
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
			["-c", "checkout.workers=0", "worktree", "add", input.path, input.branch],
			input.signal,
		);
	}

	async captureResultCommit(input: {
		worktreePath: string;
		workerId: string;
		startingCommit: string;
		signal?: AbortSignal;
	}): Promise<GitResultCommit> {
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
		const resultCommit = (
			await this.git(input.worktreePath, ["rev-parse", "HEAD"], input.signal)
		).trim();
		return {
			startingCommit: input.startingCommit,
			resultCommit,
			changedFiles,
		};
	}

	async integrate(input: {
		coordinatorCwd: string;
		startingCommit: string;
		resultCommit: string;
		signal?: AbortSignal;
	}): Promise<GitIntegrationResult> {
		if (input.startingCommit === input.resultCommit) {
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
			return {
				status: "conflict",
				conflictingFiles: await this.conflictingFiles(
					input.coordinatorCwd,
					input.signal,
				),
			};
		}
		const headBefore = (
			await this.git(input.coordinatorCwd, ["rev-parse", "HEAD"], input.signal)
		).trim();
		try {
			await this.git(
				input.coordinatorCwd,
				["merge", "--no-ff", "--no-commit", input.resultCommit],
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
				(await this.mergeInProgress(input.coordinatorCwd))
			) {
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

	async conflictingFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await this.git(
			cwd,
			["diff", "--name-only", "--diff-filter=U", "-z"],
			signal,
		);
		return output.split("\0").filter(Boolean).sort();
	}

	async mergeInProgress(cwd: string, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"], signal);
			return true;
		} catch (error) {
			if (error instanceof GitCommandError) return false;
			throw error;
		}
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
			await this.git(input.repositoryRoot, ["worktree", "prune"]);
			return true;
		}
		if (input.expectedHead) {
			const head = (await this.git(target, ["rev-parse", "HEAD"])).trim();
			if (head !== input.expectedHead) return false;
		}
		if ((await this.changedFiles(target)).length > 0) return false;
		await this.git(input.repositoryRoot, ["worktree", "remove", target]);
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
