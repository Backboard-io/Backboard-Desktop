import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BACKBOARD_CONFIG_DIR_NAME = ".backboard";
export const MCP_CONFIG_FILE_NAME = "mcp.json";
export const HOOK_CONFIG_FILE_NAME = "hooks.json";
export const SESSION_DIR_NAME = "sessions";

export interface McpConfigPaths {
	project: string;
	user: string;
}

export interface HookConfigPaths {
	project: string;
	user: string;
}

export function findRepoRoot(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

export function qProjectConfigDir(cwd: string): string {
	return path.join(findRepoRoot(cwd), BACKBOARD_CONFIG_DIR_NAME);
}

export function qUserConfigDir(homeDir = os.homedir()): string {
	return path.join(homeDir, BACKBOARD_CONFIG_DIR_NAME);
}

export function qProjectMcpConfigPath(cwd: string): string {
	return path.join(qProjectConfigDir(cwd), MCP_CONFIG_FILE_NAME);
}

export function qUserMcpConfigPath(homeDir?: string): string {
	return path.join(qUserConfigDir(homeDir), MCP_CONFIG_FILE_NAME);
}

export function qProjectHookConfigPath(cwd: string): string {
	return path.join(qProjectConfigDir(cwd), HOOK_CONFIG_FILE_NAME);
}

export function qUserHookConfigPath(homeDir?: string): string {
	return path.join(qUserConfigDir(homeDir), HOOK_CONFIG_FILE_NAME);
}

/**
 * Location for a session's logs and scratch files. Defaults to
 * `<baseDir>/.backboard/sessions/<id>` (the interactive CLI's behavior). When
 * `BACKBOARD_SESSION_ROOT` is set — as the IDE does for its serve subprocess —
 * logs go to `<BACKBOARD_SESSION_ROOT>/<id>` instead, keeping the agent's
 * bookkeeping out of the user's workspace so it never appears as file changes.
 */
export function qSessionDir(baseDir: string, sessionId: string): string {
	const override = process.env.BACKBOARD_SESSION_ROOT?.trim();
	if (override) {
		return path.join(override, sessionId);
	}
	return path.join(
		baseDir,
		BACKBOARD_CONFIG_DIR_NAME,
		SESSION_DIR_NAME,
		sessionId,
	);
}
