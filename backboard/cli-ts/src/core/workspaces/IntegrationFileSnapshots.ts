import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { runGitCommand } from "./GitWorktreeManager.ts";
import type { WorkerIntegrationChangeBytes } from "./WorkerWorkspaceTypes.ts";

type Content = NonNullable<WorkerIntegrationChangeBytes["before"]>;

/** Read exact regular-file/symlink bytes without following the final path. */
export async function captureCoordinatorFiles(
	cwd: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<Map<string, Content>> {
	const result = new Map<string, Content>();
	for (const path of paths) {
		signal?.throwIfAborted();
		const filePath = resolve(cwd, path);
		try {
			const stat = await lstat(filePath);
			let value: Content;
			if (stat.isSymbolicLink()) {
				value = {
					content: Buffer.from(await readlink(filePath)),
					mode: 0o120000,
				};
			} else {
				if (!stat.isFile())
					throw new Error(`Unsupported worker integration capture: ${path}`);
				const file = await open(
					filePath,
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				try {
					const before = await file.stat();
					if (!before.isFile())
						throw new Error(`Unsupported worker integration capture: ${path}`);
					const content = await file.readFile({ signal });
					const after = await file.stat();
					if (
						before.size !== after.size ||
						before.mtimeMs !== after.mtimeMs ||
						before.ctimeMs !== after.ctimeMs ||
						content.length !== after.size
					)
						throw new Error(
							`Coordinator file changed during integration capture: ${path}`,
						);
					value = { content, mode: before.mode & 0o111 ? 0o100755 : 0o100644 };
				} finally {
					await file.close();
				}
			}
			result.set(filePath, value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return result;
}

/** Capture the staged merge's actual checkout bytes, including CRLF/smudge output. */
export async function captureIntegrationTree(
	cwd: string,
	tree: string,
	paths: readonly string[],
	before: ReadonlyMap<string, Content>,
	signal?: AbortSignal,
): Promise<WorkerIntegrationChangeBytes[]> {
	if (!/^[a-f0-9]{40,64}$/.test(tree))
		throw new Error("Invalid worker integration tree identity.");
	const after = await captureCoordinatorFiles(cwd, paths, signal);
	if (paths.length) {
		try {
			await runGitCommand(
				cwd,
				["--literal-pathspecs", "diff", "--quiet", "--", ...paths],
				{ signal },
			);
		} catch {
			signal?.throwIfAborted();
			throw new Error(
				"Coordinator worker paths changed outside the staged integration; result preserved.",
			);
		}
	}
	return paths.map((path) => {
		const filePath = resolve(cwd, path);
		return {
			filePath,
			before: before.get(filePath),
			after: after.get(filePath),
		};
	});
}
