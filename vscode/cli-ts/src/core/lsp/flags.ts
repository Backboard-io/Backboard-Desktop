/**
 * Runtime knobs for the LSP subsystem, resolved once from the environment.
 *
 * These mirror the spirit of opencode's runtime flags but stay flat and env
 * driven so eval runs are deterministic without touching the Config class:
 *
 * - `enabled`         master switch (default off; on when LSP=1/true).
 * - `allowDownload`   whether missing servers may be fetched/installed at
 *                     runtime. Defaults off under benchmark mode so trials are
 *                     hermetic and fast, on otherwise.
 * - `cacheDir`        directory that holds pre-provisioned server binaries and
 *                     the npm install prefix. Checked before PATH.
 */
export interface LspFlags {
	enabled: boolean;
	allowDownload: boolean;
	cacheDir: string;
}

function isFalsy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v === "0" || v === "false" || v === "off" || v === "no";
}

function isTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function resolveLspFlags(
	env: Record<string, string | undefined> = process.env,
): LspFlags {
	const benchmark = isTruthy(env.BACKBOARD_BENCHMARK);
	const enabled = isTruthy(env.BACKBOARD_LSP);

	// Downloads default off in benchmark mode (rely on the pre-provisioned
	// cache) and on otherwise. Either default can be overridden explicitly.
	let allowDownload = !benchmark;
	if (isTruthy(env.BACKBOARD_LSP_DOWNLOAD)) allowDownload = true;
	if (isFalsy(env.BACKBOARD_LSP_DOWNLOAD)) allowDownload = false;
	if (isTruthy(env.BACKBOARD_DISABLE_LSP_DOWNLOAD)) allowDownload = false;

	const cacheDir =
		env.BACKBOARD_LSP_DIR?.trim() ||
		env.LSP_CACHE_DIR?.trim() ||
		defaultCacheDir(env);

	return { enabled, allowDownload, cacheDir };
}

function defaultCacheDir(env: Record<string, string | undefined>): string {
	const home = env.HOME || env.USERPROFILE || "";
	return home ? `${home}/.backboard/lsp` : ".backboard/lsp";
}
