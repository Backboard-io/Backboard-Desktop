import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import { ensureDir, renameOver } from "../../utils/fs.ts";
import { shortId } from "../../utils/id.ts";
import { type BlobStore, sha256Hex } from "./blobStore.ts";

/**
 * Files whose mtime falls within this window before the previous refresh are
 * "racy" (the git racy-index problem): a same-size in-place rewrite landing in
 * the same mtime tick as the cached stat would otherwise be invisible to the
 * (size, mtimeMs) cache. Sized to cover coarse filesystem/kernel timestamp
 * granularity (up to ~10ms on Linux) with margin.
 */
export const RACY_MTIME_WINDOW_MS = 100;

/** Directory names never descended into (VCS internals, deps, build output). */
const DENY_DIRS = new Set([
	".git",
	".backboard",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".turbo",
	"coverage",
]);

/**
 * Files stat-ed/hashed at once during a refresh. The scan is I/O bound, so a
 * sequential walk leaves a cold first scan of a large tree several times slower
 * than it needs to be; the cap bounds open files and buffered content.
 */
const REFRESH_CONCURRENCY = 16;

const INDEX_CACHE_VERSION = 1;

/** On-disk form of the index, shared by every session of one workspace. */
interface PersistedIndex {
	version: number;
	root: string;
	refreshedAt: number;
	entries: IndexEntry[];
}

/**
 * Where the index of `root` is persisted. It lives inside the blob store it
 * describes, so a `stored` flag read back from it can never outlive its blobs.
 */
export function workspaceIndexCachePath(
	objectsRoot: string,
	root: string,
): string {
	const id = sha256Hex(Buffer.from(indexPathKey(root))).slice(0, 16);
	return join(objectsRoot, "workspace-index", `${id}.json`);
}

const RIPGREP_IGNORED_DIR_GLOBS = [...DENY_DIRS].flatMap((dir) => [
	`!${dir}/**`,
	`!**/${dir}/**`,
]);

export interface IndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	mode: number;
	hash?: string;
	/** The content behind `hash` is in the blob store (restorable). */
	stored?: boolean;
	/** Legacy oversized-file marker; no longer set now that size caps are gone. */
	tooLarge?: boolean;
}

export type WorkspaceSnapshot = Map<string, IndexEntry>;

export interface WorkspaceDiffEntry {
	path: string;
	/** State at the `before` snapshot; null when the path did not exist. */
	before: IndexEntry | null;
	/** Content hash after; null when deleted or the after-file is too large. */
	afterHash: string | null;
	afterTooLarge?: boolean;
}

export interface WorkspaceDiff {
	created: WorkspaceDiffEntry[];
	modified: WorkspaceDiffEntry[];
	deleted: WorkspaceDiffEntry[];
}

/**
 * Incremental content index of a workspace tree, used to detect the file
 * side-effects of shell commands (which, unlike Edit/Write, cannot journal
 * their own pre-images). A refresh stats every file under the root and only
 * re-reads/re-hashes files whose (size, mtimeMs) changed — plus "racy" files
 * whose mtime is too close to the previous refresh to be trusted — the blob
 * write for a changed file doubles as its pre-image capture. Symlinks are never
 * followed and deny-listed directories are never entered.
 *
 * With a `cachePath` the index survives the process: a new session seeds itself
 * from the last persisted refresh, so its first scan is a stat walk instead of
 * a re-read of the whole tree - which otherwise stalls the first turn of every
 * session for as long as the workspace takes to hash.
 */
export class WorkspaceIndex {
	private readonly entries: WorkspaceSnapshot = new Map();
	private disabledReason: string | null = null;
	/** Wall-clock start of the refresh that produced `entries` (racy check). */
	private lastRefreshAt = 0;
	private cacheLoaded = false;
	readonly root: string;

	constructor(
		root: string,
		private readonly cachePath?: string,
	) {
		this.root = resolve(root);
		this.disabledReason = unindexableRootReason(this.root);
	}

	/** Non-null once the index shut itself off; refresh() is then a no-op. */
	get disabled(): string | null {
		return this.disabledReason;
	}

	/**
	 * Re-scans the tree, stores changed content into `blobs`, and returns the
	 * new snapshot (callers diff successive snapshots). Returns null when the
	 * index is (or becomes) disabled.
	 *
	 * `storeBlobs: false` hashes without writing blobs — used by the startup
	 * warm-up so sessions that never run a shell command write nothing to
	 * disk. A later storing refresh upgrades un-stored entries (re-reading
	 * their bytes) before any command relies on them as pre-images.
	 */
	async refresh(
		blobs: BlobStore,
		opts: { storeBlobs?: boolean } = {},
	): Promise<WorkspaceSnapshot | null> {
		const storeBlobs = opts.storeBlobs ?? true;
		if (this.disabledReason) return null;
		await this.loadCache();
		const startedAt = Date.now();
		const prevRefreshAt = this.lastRefreshAt;
		const paths: string[] = [];
		try {
			await this.walk(this.root, paths);
		} catch (error) {
			this.disable(`workspace scan failed: ${errorMessage(error)}`);
			return null;
		}
		if (this.disabledReason) return null;

		const scanned = new Array<IndexEntry | null>(paths.length).fill(null);
		let cursor = 0;
		const scanNext = async (): Promise<void> => {
			while (cursor < paths.length) {
				const slot = cursor++;
				const path = paths[slot] as string;
				let stats: Awaited<ReturnType<typeof lstat>>;
				try {
					stats = await lstat(path);
				} catch {
					// Deleted between readdir and stat (build churn): not a file now.
					continue;
				}
				if (!stats.isFile()) continue;
				scanned[slot] = await this.entryFor(
					path,
					stats,
					blobs,
					storeBlobs,
					prevRefreshAt,
				);
			}
		};
		await Promise.all(
			Array.from({ length: REFRESH_CONCURRENCY }, () => scanNext()),
		);

		// Slots keep the walk order, so snapshots stay deterministic.
		const next: WorkspaceSnapshot = new Map();
		for (const entry of scanned) {
			if (entry) next.set(indexPathKey(entry.path), entry);
		}
		const changed = !sameSnapshot(this.entries, next);
		this.entries.clear();
		for (const [key, entry] of next) this.entries.set(key, entry);
		this.lastRefreshAt = startedAt;
		if (changed) await this.saveCache(startedAt);
		return next;
	}

	/**
	 * Seeds an empty index from the persisted one, once per process. The
	 * persisted refresh time becomes `lastRefreshAt`, so the racy-mtime rule
	 * applies to seeded entries exactly as it does to in-memory ones. Anything
	 * unreadable or mismatched is ignored: the refresh then hashes from scratch.
	 */
	private async loadCache(): Promise<void> {
		if (this.cacheLoaded) return;
		this.cacheLoaded = true;
		if (!this.cachePath || this.entries.size > 0) return;
		try {
			const persisted = JSON.parse(
				await readFile(this.cachePath, "utf8"),
			) as PersistedIndex;
			if (
				persisted.version !== INDEX_CACHE_VERSION ||
				indexPathKey(persisted.root) !== indexPathKey(this.root) ||
				!Array.isArray(persisted.entries) ||
				!(persisted.refreshedAt <= Date.now())
			) {
				return;
			}
			for (const entry of persisted.entries) {
				this.entries.set(indexPathKey(entry.path), entry);
			}
			this.lastRefreshAt = persisted.refreshedAt;
		} catch {
			// Missing or truncated cache: not an error, just a cold scan.
		}
	}

	/** Best-effort: a failed write only costs the next session a cold scan. */
	private async saveCache(refreshedAt: number): Promise<void> {
		if (!this.cachePath) return;
		const persisted: PersistedIndex = {
			version: INDEX_CACHE_VERSION,
			root: this.root,
			refreshedAt,
			entries: [...this.entries.values()],
		};
		const temp = `${this.cachePath}.${shortId("tmp")}`;
		try {
			await ensureDir(dirname(this.cachePath), 0o700);
			await writeFile(temp, JSON.stringify(persisted), { mode: 0o600 });
			// Sessions of one workspace share this file; rename keeps readers
			// from ever seeing a half-written index.
			await renameOver(temp, this.cachePath);
		} catch {
			await rm(temp, { force: true }).catch(() => {});
		}
	}

	/** Per-path changes between two snapshots returned by `refresh()`. */
	diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
		const created: WorkspaceDiffEntry[] = [];
		const modified: WorkspaceDiffEntry[] = [];
		const deleted: WorkspaceDiffEntry[] = [];
		for (const [key, entry] of after) {
			const prev = before.get(key);
			if (!prev) {
				created.push({
					path: entry.path,
					before: null,
					afterHash: entry.hash ?? null,
					...(entry.tooLarge ? { afterTooLarge: true } : {}),
				});
			} else if (prev.hash !== entry.hash || prev.tooLarge !== entry.tooLarge) {
				modified.push({
					path: entry.path,
					before: prev,
					afterHash: entry.hash ?? null,
					...(entry.tooLarge ? { afterTooLarge: true } : {}),
				});
			}
		}
		for (const [key, prev] of before) {
			if (!after.has(key)) {
				deleted.push({ path: prev.path, before: prev, afterHash: null });
			}
		}
		return { created, modified, deleted };
	}

	private disable(reason: string): void {
		this.disabledReason = reason;
		this.entries.clear();
	}

	private async walk(dir: string, paths: string[]): Promise<void> {
		const ripgrepPaths = await listFilesWithRipgrep(dir);
		if (ripgrepPaths) {
			for (const path of ripgrepPaths) {
				paths.push(resolve(dir, path));
			}
			return;
		}
		await this.walkWithoutIgnoreFiles(dir, paths);
	}

	/** Fallback for environments where ripgrep is unavailable. */
	private async walkWithoutIgnoreFiles(
		dir: string,
		paths: string[],
	): Promise<void> {
		let dirents: Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory (permissions, raced delete): skip its subtree.
			return;
		}
		for (const dirent of dirents) {
			if (this.disabledReason) return;
			if (dirent.isSymbolicLink()) continue;
			const path = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				if (DENY_DIRS.has(dirent.name)) continue;
				await this.walkWithoutIgnoreFiles(path, paths);
			} else if (dirent.isFile()) {
				paths.push(path);
			}
			// Sockets/FIFOs/devices: never indexed.
		}
	}

	/**
	 * Reuses the cached hash when (size, mtimeMs) is unchanged — unless this
	 * is a storing refresh and the cached entry's bytes were never written to
	 * the blob store (hash-only warm-up), or the cached mtime is within
	 * RACY_MTIME_WINDOW_MS of the refresh that recorded it (a same-tick,
	 * same-size rewrite would be indistinguishable from the cached state).
	 * In either case the file is re-read.
	 */
	private async entryFor(
		path: string,
		stats: { size: number; mtimeMs: number; mode: number },
		blobs: BlobStore,
		storeBlobs: boolean,
		prevRefreshAt: number,
	): Promise<IndexEntry | null> {
		const base = {
			path,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			mode: stats.mode & 0o777,
		};
		const cached = this.entries.get(indexPathKey(path));
		if (
			cached &&
			!cached.tooLarge &&
			cached.size === stats.size &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.mtimeMs < prevRefreshAt - RACY_MTIME_WINDOW_MS &&
			cached.hash &&
			(cached.stored || !storeBlobs)
		) {
			return { ...base, hash: cached.hash, stored: cached.stored };
		}
		let content: Uint8Array;
		try {
			content = await readFile(path);
		} catch {
			// Deleted/locked mid-scan: treat as absent this round.
			return null;
		}
		const hash = sha256Hex(content);
		// A racy re-read that confirms unchanged content skips the blob write.
		const alreadyStored = cached?.hash === hash && cached.stored === true;
		if (storeBlobs && !alreadyStored) await blobs.put(content);
		return {
			...base,
			hash,
			...(storeBlobs || alreadyStored ? { stored: true } : {}),
		};
	}
}

/**
 * A home directory or filesystem root is never a workspace worth indexing:
 * walking it reads every folder macOS guards behind a privacy prompt
 * (Desktop, Documents, Downloads, iCloud Drive, other apps' containers) and
 * hashes far more than any shell command could change.
 */
function unindexableRootReason(root: string): string | null {
	if (root === parse(root).root) return "workspace is the filesystem root";
	if (root === resolve(homedir())) return "workspace is the home directory";
	return null;
}

/**
 * Enumerates files with the same ignore semantics as the CLI's search tools.
 * `--no-require-git` makes nested `.gitignore`, `.ignore`, and `.rgignore`
 * files effective even when a workspace is not itself a Git repository.
 * Returns null only when ripgrep is missing, so the Node walker can take over.
 */
function listFilesWithRipgrep(root: string): Promise<string[] | null> {
	return new Promise((resolvePromise, reject) => {
		const args = ["--files", "--hidden", "--no-require-git", "--null"];
		for (const glob of RIPGREP_IGNORED_DIR_GLOBS) {
			args.push("--glob", glob);
		}
		const child = spawn("rg", args, { cwd: root });
		const stdout: Buffer[] = [];
		let stderr = "";
		let missing = false;
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				missing = true;
				return;
			}
			reject(error);
		});
		child.on("close", (code) => {
			if (missing) {
				resolvePromise(null);
				return;
			}
			if (code !== 0 && code !== 1) {
				reject(
					new Error(
						stderr.trim() || `ripgrep file listing failed (exit ${code ?? 1})`,
					),
				);
				return;
			}
			const output = Buffer.concat(stdout).toString();
			resolvePromise(output.split("\0").filter(Boolean));
		});
	});
}

function sameSnapshot(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
	if (a.size !== b.size) return false;
	for (const [key, entry] of b) {
		const prev = a.get(key);
		if (
			!prev ||
			prev.hash !== entry.hash ||
			prev.size !== entry.size ||
			prev.mtimeMs !== entry.mtimeMs ||
			prev.mode !== entry.mode ||
			prev.stored !== entry.stored
		) {
			return false;
		}
	}
	return true;
}

/** Same case-normalization as CheckpointStore.pathKey. */
export function indexPathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "darwin" || process.platform === "win32"
		? resolved.toLowerCase()
		: resolved;
}
