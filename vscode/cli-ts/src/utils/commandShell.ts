import { existsSync } from "node:fs";

export type CommandShellKind = "bash" | "posix";

export interface CommandShell {
	kind: CommandShellKind;
	path: string;
}

const BASH_CANDIDATES = [
	process.env.BASH,
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/bash",
].filter((path): path is string => Boolean(path));

let cachedDefaultShell: CommandShell | undefined;

export function detectCommandShell(
	exists: (path: string) => boolean = existsSync,
): CommandShell {
	// The shell location is fixed for a process; memoize the default-`exists`
	// path so `ToolRegistry.toJSONSchemasFor` (called every turn) doesn't run
	// up to 5 `existsSync` stats each time. Tests pass a custom `exists` and
	// intentionally bypass the cache.
	const useCache = exists === existsSync;
	if (useCache && cachedDefaultShell) {
		return cachedDefaultShell;
	}
	let shell: CommandShell = {
		kind: "posix",
		path: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
	};
	for (const path of BASH_CANDIDATES) {
		if (exists(path)) {
			shell = { kind: "bash", path };
			break;
		}
	}
	if (useCache) {
		cachedDefaultShell = shell;
	}
	return shell;
}
