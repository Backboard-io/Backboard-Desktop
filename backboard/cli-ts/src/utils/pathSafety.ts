import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Returns the first existing symbolic-link component whose target cannot be
 * resolved because it does not exist. A normal missing path is safe to create;
 * a dangling link is not, because a write would follow it to a different
 * lexical location while authorization and locking reason about the link name.
 */
export function findDanglingSymlink(path: string): string | undefined {
	let current = resolve(path);
	for (;;) {
		try {
			if (lstatSync(current).isSymbolicLink()) {
				try {
					realpathSync(current);
				} catch (error) {
					if (errorCode(error) === "ENOENT") return current;
					throw error;
				}
			}
		} catch (error) {
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}

		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function assertNoDanglingSymlink(path: string): void {
	const dangling = findDanglingSymlink(path);
	if (dangling) {
		throw new Error(
			`Refusing to mutate a path containing a dangling symbolic link: ${dangling}`,
		);
	}
}

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}
