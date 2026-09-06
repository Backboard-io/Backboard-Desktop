import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { APP_VERSION } from "./branding.ts";

export const PROTOCOL_VERSION = 1;
export const PROMPT_VERSION = "2026-09-04.1";
export interface BuildInfo {
	sha: string | null;
	timestamp: string | null;
	dirty: boolean | null;
}
declare const BACKBOARD_BUILD_INFO: BuildInfo | undefined;

export function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
}

/** Git runs against the source location, never the user's workspace. */
export async function sourceBuildInfo(): Promise<BuildInfo> {
	try {
		const options = {
			cwd: resolve(import.meta.dir, "../.."),
			timeout: 2_000,
			maxBuffer: 128_000,
		};
		const run = promisify(execFile);
		const [sha, dirty] = await Promise.all([
			run("git", ["rev-parse", "HEAD"], options),
			run(
				"git",
				[
					"status",
					"--porcelain",
					"--untracked-files=normal",
					"--",
					"src",
					"scripts",
					"package.json",
				],
				options,
			),
		]);
		return {
			sha: sha.stdout.trim(),
			timestamp: null,
			dirty: dirty.stdout.length > 0,
		};
	} catch {
		return { sha: null, timestamp: null, dirty: null };
	}
}

let identity: Promise<ReturnType<typeof describeRuntime>> | undefined;
function describeRuntime(build: BuildInfo) {
	return {
		executablePath: process.execPath,
		mode: typeof BACKBOARD_BUILD_INFO === "undefined" ? "source" : "compiled",
		build,
		runtimeVersion: `bun/${Bun.version}`,
		applicationVersion: APP_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		promptVersion: PROMPT_VERSION,
	};
}

export function runtimeIdentity() {
	identity ??= (
		typeof BACKBOARD_BUILD_INFO === "undefined"
			? sourceBuildInfo()
			: Promise.resolve(BACKBOARD_BUILD_INFO)
	).then(describeRuntime);
	return identity;
}
