import { realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { assertNoDanglingSymlink } from "./pathSafety.ts";

const lockTails = new Map<string, Promise<void>>();
let canonicalizationTail: Promise<void> = Promise.resolve();

export async function withPathLocks<T>(
	paths: readonly string[],
	fn: () => Promise<T>,
): Promise<T> {
	const releases: Array<() => void> = [];
	// Resolve keys in invocation order. realpath is asynchronous; without this
	// short queue a later same-path edit can finish canonicalization first and
	// overtake an earlier provider call. Only key resolution is serialized;
	// disjoint filesystem mutations still run concurrently.
	const canonicalized = canonicalizationTail.then(() =>
		Promise.all(paths.map(canonicalLockPath)),
	);
	canonicalizationTail = canonicalized.then(
		() => undefined,
		() => undefined,
	);
	const uniquePaths = [...new Set(await canonicalized)].sort();
	try {
		for (const path of uniquePaths) {
			releases.push(await acquirePathLock(path));
		}
		return await fn();
	} finally {
		for (const release of releases.reverse()) release();
	}
}

/**
 * Resolve aliases before selecting a lock key. Existing paths use realpath so
 * symlink spellings serialize together. New paths use the nearest existing
 * ancestor, then append the missing suffix. Case folding on Windows/macOS may
 * over-serialize a case-sensitive volume, but never permits two names for the
 * same default filesystem entry to mutate concurrently.
 */
export async function canonicalLockPath(path: string): Promise<string> {
	return normalizeCase(await canonicalPhysicalPath(path));
}

/**
 * Resolve aliases while retaining the filesystem's canonical spelling. Use
 * this for persisted paths and actual I/O; canonicalLockPath additionally
 * case-folds this value and is only an in-process lock identity.
 */
export async function canonicalPhysicalPath(path: string): Promise<string> {
	const absolute = resolve(path);
	// A dangling link has no stable physical target to lock. Treating it like a
	// normal missing path would let two aliases acquire different locks and then
	// follow the link during mutation.
	assertNoDanglingSymlink(absolute);
	let current = absolute;
	for (;;) {
		try {
			const existing = await realpath(current);
			const suffix = relative(current, absolute);
			return suffix ? join(existing, suffix) : existing;
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current || current === parse(current).root) {
				return absolute;
			}
			current = parent;
		}
	}
}

function normalizeCase(path: string): string {
	return process.platform === "darwin" || process.platform === "win32"
		? path.toLocaleLowerCase("en-US")
		: path;
}

async function acquirePathLock(path: string): Promise<() => void> {
	const previous = lockTails.get(path) ?? Promise.resolve();
	let releaseGate: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const current = previous.then(() => gate);
	lockTails.set(path, current);
	await previous;
	return () => {
		releaseGate();
		void current.finally(() => {
			if (lockTails.get(path) === current) lockTails.delete(path);
		});
	};
}
