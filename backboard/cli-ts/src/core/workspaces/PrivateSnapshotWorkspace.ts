import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { withPathLocks } from "../../utils/pathLocks.ts";
import {
	runGitCommand,
	type GitIntegrationResult,
	type GitRepositoryInfo,
} from "./GitWorktreeManager.ts";
import type {
	WorkerIntegrationChangeBytes,
	WorkerWorkspaceRecord,
} from "./WorkerWorkspaceTypes.ts";

export type SnapshotMutation = (
	record: WorkerWorkspaceRecord,
	paths: readonly string[],
	apply: () => Promise<void>,
) => Promise<void>;
export const SNAPSHOT_LIMITS = {
	files: 100_000,
	bytes: 1024 * 1024 * 1024,
	fileBytes: 16 * 1024 * 1024,
} as const;
// Baselines can span a large repository; integration still bounds worker edits.
const INTEGRATION_LIMITS = {
	files: 10_000,
	bytes: 2 * 128 * 1024 * 1024,
} as const;
interface Entry {
	path: string;
	before: Buffer | null;
	after: Buffer | null;
	beforeMode: number;
	afterMode: number;
}

/** Private Git stores immutable baselines/results; it never initializes the user's folder. */
export class PrivateSnapshotWorkspace {
	constructor(
		private readonly root: string,
		private readonly mutate?: SnapshotMutation,
	) {}

	async create(
		coordinatorCwd: string,
		signal?: AbortSignal,
	): Promise<GitRepositoryInfo> {
		signal?.throwIfAborted();
		const coordinatorRoot = await realpath(coordinatorCwd);
		const storage = join(this.root, "snapshots");
		if (inside(coordinatorRoot, storage))
			throw new Error(
				"Private snapshot storage must be outside the coordinator folder.",
			);
		await mkdir(storage, { recursive: true, mode: 0o700 });
		if (inside(coordinatorRoot, await realpath(storage)))
			throw new Error(
				"Private snapshot storage must be outside the coordinator folder.",
			);
		const repositoryRoot = await mkdtemp(join(storage, "snapshot-"));
		let bytes = 0;
		try {
			await git(repositoryRoot, ["init", "--quiet"]);
			const listingArgs = [
				"--git-dir",
				join(repositoryRoot, ".git"),
				"--work-tree",
				coordinatorRoot,
				"ls-files",
				"--others",
				"--exclude-standard",
				"-z",
				...[
					"node_modules",
					".cache",
					".next",
					".turbo",
					".venv",
					"__pycache__",
					".backboard",
					".backboard_ide",
				].map((name) => `--exclude=**/${name}/**`),
			];
			const tracked = new Set<string>();
			try {
				for (const path of (
					await git(coordinatorRoot, ["ls-files", "--cached", "-z"])
				)
					.split("\0")
					.filter(Boolean))
					tracked.add(path);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("not a git repository")
				)
					throw error;
			}
			const inventory = [
				...new Set([
					...tracked,
					...(await git(coordinatorRoot, listingArgs))
						.split("\0")
						.filter(Boolean),
				]),
			].sort();
			if (inventory.length > SNAPSHOT_LIMITS.files)
				throw new Error(
					`Worker snapshot contains ${inventory.length.toLocaleString("en-US")} source files, exceeding the ${SNAPSHOT_LIMITS.files.toLocaleString("en-US")}-file limit; use a narrower workspace.`,
				);
			for (const path of inventory) {
				signal?.throwIfAborted();
				const from = safeTarget(coordinatorRoot, path);
				const to = safeTarget(repositoryRoot, path);
				await safeParents(coordinatorRoot, path);
				let input;
				try {
					input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code === "ENOENT" &&
						tracked.has(path)
					)
						continue;
					throw new Error(
						`Cannot snapshot ${path}: symbolic links, inaccessible files, and files changed during capture require a narrower workspace.`,
						{ cause: error },
					);
				}
				try {
					const stat = await input.stat();
					if (
						!stat.isFile() ||
						stat.size > SNAPSHOT_LIMITS.fileBytes ||
						(bytes += stat.size) > SNAPSHOT_LIMITS.bytes
					)
						throw new Error(
							"Worker snapshot exceeds the file or byte limit; use a narrower workspace (1 GiB total, 16 MiB per file).",
						);
					const content = await input.readFile();
					if (content.length !== stat.size)
						throw new Error(
							`File changed while snapshotting: ${path}. Retry once editing has settled.`,
						);
					await mkdir(dirname(to), { recursive: true });
					await durableWrite(to, content, stat.mode & 0o777, false);
				} finally {
					await input.close();
				}
			}
			for (const [key, value] of [
				["core.autocrlf", "false"],
				["core.hooksPath", "/dev/null"],
				["core.attributesFile", "/dev/null"],
			])
				await git(repositoryRoot, ["config", key!, value!]);
			await durableWrite(
				join(repositoryRoot, ".git", "info", "attributes"),
				Buffer.from("* -text -filter -ident -working-tree-encoding\n"),
				0o600,
			);
			// Ignore/filter/hooks settings from the coordinator must not change its copied bytes.
			await git(repositoryRoot, [
				"-c",
				"core.autocrlf=false",
				"add",
				"--all",
				"--force",
			]);
			await git(repositoryRoot, [
				"-c",
				"user.name=Backboard Snapshot",
				"-c",
				"user.email=workers@backboard.local",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--quiet",
				"--allow-empty",
				"--no-gpg-sign",
				"-m",
				"Private worker snapshot",
			]);
			signal?.throwIfAborted();
			await durableWrite(
				join(repositoryRoot, ".git", "backboard-snapshot.json"),
				Buffer.from(JSON.stringify({ coordinatorRoot })),
				0o600,
				false,
			);
			return {
				coordinatorRoot,
				repositoryRoot,
				head: (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim(),
			};
		} catch (error) {
			await rm(repositoryRoot, { recursive: true, force: true });
			throw error;
		}
	}

	async integrate(
		record: WorkerWorkspaceRecord,
		captureChanges?: (changes: WorkerIntegrationChangeBytes[]) => Promise<void>,
	): Promise<GitIntegrationResult> {
		const repo = await this.validate(record);
		const entries = await this.entries(repo, record);
		if (!this.mutate && entries.length)
			throw new Error(
				"Private worker integration requires the coordinator checkpoint transaction; result preserved for retry.",
			);
		const paths = entries.map((entry) =>
			safeTarget(record.coordinatorCwd, entry.path),
		);
		return withPathLocks(paths, async () => {
			const conflicts: string[] = [];
			const changes: WorkerIntegrationChangeBytes[] = [];
			for (const entry of entries) {
				const state = await current(record.coordinatorCwd, entry.path);
				if (
					!same(state, entry.before, entry.beforeMode) &&
					!same(state, entry.after, entry.afterMode)
				)
					conflicts.push(entry.path);
				if (!same(state, entry.after, entry.afterMode)) {
					changes.push({
						filePath: safeTarget(record.coordinatorCwd, entry.path),
						before: state
							? {
									content: state.content,
									mode: state.mode & 0o111 ? 0o100755 : 0o100644,
								}
							: undefined,
						after: entry.after
							? { content: entry.after, mode: entry.afterMode }
							: undefined,
					});
				}
			}
			if (conflicts.length)
				return { status: "conflict", conflictingFiles: conflicts };
			// Recovery retains the original durable plan, including files a crashed
			// earlier attempt already applied. Fresh no-op paths are not invented edits.
			if (!record.integrationPlan) await captureChanges?.(changes);
			const journal = join(
				repo,
				".git",
				`backboard-integration-${record.workerId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
			);
			await durableWrite(
				journal,
				Buffer.from(
					JSON.stringify({
						workerId: record.workerId,
						coordinatorCwd: record.coordinatorCwd,
						startingCommit: record.startingCommit,
						resultCommit: record.resultCommit,
						paths: entries.map((entry) => entry.path),
					}),
				),
				0o600,
			);
			if (entries.length)
				await this.mutate!(record, paths, async () => {
					for (const entry of entries) {
						const state = await current(record.coordinatorCwd, entry.path);
						if (same(state, entry.after, entry.afterMode)) continue;
						if (!same(state, entry.before, entry.beforeMode))
							throw new Error(
								`Coordinator file changed during worker integration: ${entry.path}; result preserved.`,
							);
						const target = safeTarget(record.coordinatorCwd, entry.path);
						if (entry.after === null) await unlink(target);
						else {
							await safeParents(record.coordinatorCwd, entry.path, true);
							const mode = state
								? (state.mode & 0o666) |
									(entry.afterMode === 0o100755 ? 0o111 : 0)
								: entry.afterMode === 0o100755
									? 0o755
									: 0o644;
							await durableWrite(target, entry.after, mode);
						}
					}
				});
			await unlink(journal);
			return { status: "integrated", conflictingFiles: [] };
		});
	}

	private async validate(record: WorkerWorkspaceRecord): Promise<string> {
		if (
			!record.repositoryRoot ||
			!record.startingCommit ||
			!record.resultCommit ||
			!/^[a-f0-9]{40,64}$/.test(record.startingCommit) ||
			!/^[a-f0-9]{40,64}$/.test(record.resultCommit)
		)
			throw new Error("Private worker snapshot metadata is incomplete.");
		const repo = await realpath(record.repositoryRoot);
		const storage = await realpath(join(this.root, "snapshots"));
		if (!inside(storage, repo) || repo === storage)
			throw new Error("Private worker snapshot is outside owned storage.");
		const marker = JSON.parse(
			await readFile(join(repo, ".git", "backboard-snapshot.json"), "utf8"),
		) as { coordinatorRoot?: string };
		if (marker.coordinatorRoot !== (await realpath(record.coordinatorCwd)))
			throw new Error("Private worker snapshot coordinator identity changed.");
		return repo;
	}

	private async entries(
		repo: string,
		record: WorkerWorkspaceRecord,
	): Promise<Entry[]> {
		const raw = (
			await git(repo, [
				"diff",
				"--raw",
				"--no-abbrev",
				"--no-renames",
				"-z",
				record.startingCommit!,
				record.resultCommit!,
				"--",
			])
		).split("\0");
		const entries: Entry[] = [];
		let bytes = 0;
		for (let index = 0; index < raw.length - 1; index += 2) {
			const header = raw[index]!;
			const path = raw[index + 1]!;
			const fields = header.slice(1).split(" ");
			const beforeMode = parseInt(fields[0]!, 8);
			const afterMode = parseInt(fields[1]!, 8);
			if (
				![0, 0o100644, 0o100755].includes(beforeMode) ||
				![0, 0o100644, 0o100755].includes(afterMode)
			)
				throw new Error(
					`Private worker integration supports regular files only: ${path}`,
				);
			safeTarget(record.coordinatorCwd, path);
			const before = beforeMode ? await blob(repo, fields[2]!) : null;
			const after = afterMode ? await blob(repo, fields[3]!) : null;
			bytes += (before?.length ?? 0) + (after?.length ?? 0);
			if (
				entries.length >= INTEGRATION_LIMITS.files ||
				bytes > INTEGRATION_LIMITS.bytes
			)
				throw new Error(
					"Private worker result exceeds integration limits; narrow the worker task.",
				);
			entries.push({ path, before, after, beforeMode, afterMode });
		}
		return entries;
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	return (await runGitCommand(cwd, args)).stdout;
}
async function blob(cwd: string, oid: string): Promise<Buffer> {
	if (!/^[a-f0-9]{40,64}$/.test(oid))
		throw new Error("Invalid private snapshot object identity.");
	return new Promise((resolveBlob, reject) =>
		execFile(
			"git",
			["cat-file", "blob", oid],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: SNAPSHOT_LIMITS.fileBytes,
				timeout: 30_000,
			},
			(error, stdout) => (error ? reject(error) : resolveBlob(stdout)),
		),
	);
}
function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
	);
}
function safeTarget(root: string, path: string): string {
	if (
		path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git") ||
		!path ||
		isAbsolute(path) ||
		!inside(resolve(root), resolve(root, path)) ||
		resolve(root, path) === resolve(root)
	)
		throw new Error(`Unsafe private worker result path: ${path}`);
	return resolve(root, path);
}
async function safeParents(
	root: string,
	path: string,
	create = false,
): Promise<void> {
	const canonicalRoot = await realpath(root);
	if (canonicalRoot !== resolve(root))
		throw new Error("Coordinator path changed or traverses a symbolic link.");
	const parts = relative(root, dirname(safeTarget(root, path)))
		.split(sep)
		.filter(Boolean);
	let cursor = root;
	for (const part of parts) {
		cursor = join(cursor, part);
		try {
			const stat = await lstat(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error(`Unsafe worker integration parent: ${cursor}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (create) await mkdir(cursor);
		}
	}
}
async function current(
	root: string,
	path: string,
): Promise<{ content: Buffer; mode: number } | null> {
	await safeParents(root, path);
	try {
		const file = await open(
			safeTarget(root, path),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > SNAPSHOT_LIMITS.fileBytes)
				throw new Error(`Unsupported coordinator file: ${path}`);
			return { content: await file.readFile(), mode: stat.mode };
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
function same(
	state: { content: Buffer; mode: number } | null,
	content: Buffer | null,
	mode: number,
): boolean {
	return content === null
		? state === null
		: state !== null &&
				state.content.equals(content) &&
				Boolean(state.mode & 0o111) === (mode === 0o100755);
}
async function durableWrite(
	path: string,
	content: Buffer,
	mode: number,
	atomic = true,
): Promise<void> {
	const temporary = atomic
		? join(dirname(path), `.backboard-write-${randomUUID()}`)
		: path;
	const file = await open(temporary, "wx", mode);
	try {
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await chmod(temporary, mode);
		if (atomic) await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} catch (error) {
			if (
				!["EINVAL", "ENOTSUP"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw error;
		} finally {
			await directory.close();
		}
	} catch (error) {
		if (atomic) await rm(temporary, { force: true });
		throw error;
	}
}
