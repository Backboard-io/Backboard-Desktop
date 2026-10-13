import { realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { assertNoDanglingSymlink } from "./pathSafety.ts";

const lockTails = new Map<string, Promise<void>>();
let canonicalizationTail: Promise<void> = Promise.resolve();

export async function withPathLocks<T>(
	paths: readonly string[],
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	// Resolve and reserve the entire set in invocation order. Reserving one
	// path at a time lets a later writer overtake a multi-file patch while that
	// patch waits for its first path. Reservation never holds a partial set.
	const reservation = canonicalizationTail.then(async () => {
		signal?.throwIfAborted();
		const keys = [...new Set(await Promise.all(paths.map(canonicalLockPath)))];
		signal?.throwIfAborted();
		const previous = Promise.all(keys.map((key) => lockTails.get(key)));
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const current = previous.then(() => gate);
		for (const key of keys) lockTails.set(key, current);
		void current.then(() => {
			for (const key of keys) {
				if (lockTails.get(key) === current) lockTails.delete(key);
			}
		});
		return { previous, release };
	});
	canonicalizationTail = reservation.then(
		() => {},
		() => {},
	);
	// If cancellation wins during canonicalization, release any reservation
	// once it arrives. Its tail still waits for preceding owners, so a cancelled
	// waiter cannot accidentally unlock a file another writer is using.
	let acquired: Awaited<typeof reservation> | undefined;
	try {
		acquired = await waitForLock(reservation, signal);
		await waitForLock(acquired.previous, signal);
		signal?.throwIfAborted();
		return await fn();
	} finally {
		if (acquired) acquired.release();
		else
			void reservation.then(
				(value) => value.release(),
				() => {},
			);
	}
}

async function waitForLock<T>(
	operation: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return operation;
	signal.throwIfAborted();
	return new Promise<T>((resolveWait, rejectWait) => {
		const onAbort = () =>
			rejectWait(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(resolveWait, rejectWait).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
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
