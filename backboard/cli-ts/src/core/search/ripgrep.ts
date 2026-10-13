import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { SearchError } from "./SearchError.ts";

export interface RipgrepCapability {
	path: string;
	version: string;
	pcre2: boolean;
}

export interface RipgrepConfiguration {
	executablePath?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	signal?: AbortSignal;
}

const capabilities = new Map<string, Promise<RipgrepCapability>>();

/** Cache successes and failures per executable/PATH configuration, including IDE's bundled PATH. */
export function resolveRipgrep(
	configuration: RipgrepConfiguration = {},
): Promise<RipgrepCapability> {
	if (configuration.signal?.aborted) {
		return Promise.reject(
			new SearchError("Search cancelled.", "cancelled", "SEARCH_CANCELLED"),
		);
	}
	const env = configuration.env ?? process.env;
	const executablePath =
		configuration.executablePath ?? env.BACKBOARD_RIPGREP_PATH;
	const cwd = configuration.cwd ?? process.cwd();
	const key = JSON.stringify([
		executablePath,
		env.PATH,
		env.PATHEXT,
		// Relative PATH entries are resolved in this cwd, not the tool's search directory.
		cwd,
	]);
	let pending = capabilities.get(key);
	if (!pending) {
		pending = inspectRipgrep(executablePath, env, cwd);
		capabilities.set(key, pending);
	}
	const signal = configuration.signal;
	if (!signal) return pending;
	// Cancelling one caller must not cancel the cached capability probe for others.
	return new Promise((resolvePromise, reject) => {
		const cancel = () =>
			reject(
				new SearchError("Search cancelled.", "cancelled", "SEARCH_CANCELLED"),
			);
		signal.addEventListener("abort", cancel, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", cancel);
				resolvePromise(value);
			},
			(error) => {
				signal.removeEventListener("abort", cancel);
				reject(error);
			},
		);
	});
}

async function inspectRipgrep(
	explicitPath: string | undefined,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<RipgrepCapability> {
	const candidates = explicitPath
		? [resolve(cwd, explicitPath)]
		: (env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.flatMap((directory) => {
					const base = isAbsolute(directory)
						? directory
						: resolve(cwd, directory);
					return process.platform === "win32"
						? [join(base, "rg.exe"), join(base, "rg")]
						: [join(base, "rg")];
				});
	let path: string | undefined;
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			path = await realpath(candidate);
			break;
		} catch {
			// Resolve only supplied PATH entries; never scan the filesystem.
		}
	}
	if (!path) {
		throw new SearchError(
			"Search unavailable: ripgrep was not found. Set BACKBOARD_RIPGREP_PATH to an executable rg path or restore the desktop bundled ripgrep/PATH. Repeating this search cannot repair the runtime configuration.",
			"unavailable",
			"RIPGREP_UNAVAILABLE",
		);
	}
	const resolvedPath = path;
	return new Promise((resolvePromise, reject) => {
		execFile(
			resolvedPath,
			["--no-config", "--version"],
			{ cwd, env, timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 8_192 },
			(error, stdout) => {
				const match = /^ripgrep (\d+)\.(\d+)\.(\d+)[^\r\n]*/m.exec(stdout);
				if (error || !match || Number(match[1]) < 12) {
					reject(
						new SearchError(
							`Search unavailable: ${resolvedPath} is not a working ripgrep 12+ executable. Restore bundled ripgrep or set BACKBOARD_RIPGREP_PATH to a compatible binary.`,
							"unavailable",
							"RIPGREP_INCOMPATIBLE",
						),
					);
					return;
				}
				resolvePromise({
					path: resolvedPath,
					version: match[0],
					pcre2: /(?:features:[^\r\n]*\+pcre2|PCRE2 .+ is available)/i.test(
						stdout,
					),
				});
			},
		);
	});
}
