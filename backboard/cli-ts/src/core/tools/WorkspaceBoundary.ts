import { resolve } from "node:path";
import { pathsInsideCwd } from "../permissions/pathsInside.ts";
import type { ToolContext } from "./ToolContext.ts";

/** Enforces the filesystem boundary attached to an isolated worker context. */
export function assertInsideIsolatedWorkspace(
	ctx: ToolContext,
	paths: readonly string[],
): void {
	const boundary = ctx.isolatedWorkspaceRoot;
	if (!boundary) return;
	const resolved = paths.map((path) => resolve(ctx.cwd, path));
	if (
		!pathsInsideCwd([ctx.cwd], boundary) ||
		!pathsInsideCwd(resolved, boundary)
	) {
		throw new Error(
			`Isolated workers may only write inside their Git worktree: ${boundary}`,
		);
	}
}
