import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ToolContext } from "./ToolContext.ts";

/** Enforces the filesystem boundary attached to an isolated worker context. */
export function assertInsideIsolatedWorkspace(
	ctx: ToolContext,
	paths: readonly string[],
): void {
	const boundary = ctx.isolatedWorkspaceRoot;
	if (!boundary) return;
	const boundaryPath = resolve(boundary);
	const boundaryReal = realpath(boundaryPath);
	const cwdPath = resolve(ctx.cwd);
	const cwdReal = nearestExistingRealpath(cwdPath);
	const targets = paths.map((path) => resolve(cwdPath, path));
	const outsideBoundary =
		boundaryReal === undefined ||
		cwdReal === undefined ||
		!isInside(boundaryPath, cwdPath) ||
		!isInside(boundaryReal, cwdReal) ||
		targets.some((target) => {
			const targetReal = nearestExistingRealpath(target);
			return (
				!isInside(boundaryPath, target) ||
				targetReal === undefined ||
				!isInside(boundaryReal, targetReal)
			);
		});
	if (outsideBoundary) {
		throw new Error(
			`Isolated workers may only write inside their Git worktree: ${boundary}`,
		);
	}
}

function realpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Resolve the closest ancestor that already exists without trusting symlinks. */
function nearestExistingRealpath(path: string): string | undefined {
	let current = path;
	while (true) {
		const resolved = realpath(current);
		if (resolved !== undefined) return resolved;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}
