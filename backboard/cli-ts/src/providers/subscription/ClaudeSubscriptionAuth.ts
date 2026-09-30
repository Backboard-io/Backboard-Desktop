import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../../config/backboardConfig.ts";
import { backboardOAuthCompleteUrl } from "../../core/auth/BackboardOAuthComplete.ts";
import { openDefaultBrowser } from "../../core/oauth/LoopbackOAuth.ts";
import { errorMessage } from "../../utils/errors.ts";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a verified login is trusted before Claude Code is asked again.
 * Asking costs a process spawn (about 0.3s) ahead of every message, and both
 * the IDE and this runtime used to ask. Claude Code still authenticates every
 * request itself, so an expired login fails the turn and clears the record.
 */
export const CLAUDE_LOGIN_TRUST_MS = 5 * 60_000;
const LOGIN_RECORD_FILE = "claude-login.json";

const STRIPPED_CLAUDE_ENV = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_PROFILE",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_VERTEX",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
]);

export interface ClaudeSubscriptionStatus {
	loggedIn: boolean;
	authMethod?: string;
	apiProvider?: string;
	executable: string;
}

export interface ClaudeSubscriptionAuthOptions {
	homeDir?: string;
	executable?: string;
	/** Test seam for the completion page opened after a successful login. */
	openBrowser?: (url: string) => Promise<void>;
}

export class ClaudeSubscriptionLoginRequiredError extends Error {
	constructor(
		message = "Claude Code is not signed in with a Claude.ai subscription. Reconnect Claude in the model picker, or run `backboard claude-subscription login`.",
	) {
		super(message);
		this.name = "ClaudeSubscriptionLoginRequiredError";
	}
}

/**
 * Build the Claude subprocess environment without any API-key, proxy, or cloud
 * provider override. This makes the user-installed Claude Code login the only
 * possible billing route for `anthropic-subscription`.
 */
export function buildClaudeSubscriptionEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const sanitized = { ...env };
	for (const key of STRIPPED_CLAUDE_ENV) delete sanitized[key];
	sanitized.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	sanitized.CLAUDE_AGENT_SDK_CLIENT_APP = "backboard-r-cli/3.0.2";
	return sanitized;
}

/** Locate Claude Code in PATH and the vendor's well-known user install dirs. */
export async function findClaudeCodeExecutable(
	options: ClaudeSubscriptionAuthOptions = {},
): Promise<string> {
	const explicit =
		options.executable?.trim() ||
		process.env.BACKBOARD_CLAUDE_CODE_PATH?.trim();
	const executableName = process.platform === "win32" ? "claude.exe" : "claude";
	const homeDir = options.homeDir ?? os.homedir();
	const pathDirs = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean);
	const candidates = [
		explicit,
		...pathDirs.map((directory) => path.join(directory, executableName)),
		path.join(homeDir, ".local", "bin", executableName),
		path.join(homeDir, "bin", executableName),
		process.platform === "win32"
			? path.join(
					homeDir,
					"AppData",
					"Local",
					"Programs",
					"claude",
					executableName,
				)
			: undefined,
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Keep looking. The final error names every supported recovery path.
		}
	}
	throw new ClaudeSubscriptionLoginRequiredError(
		"Claude Code is not installed. Install Claude Code, then choose Connect Claude again.",
	);
}

/** Ask Claude Code for status; never reads or exposes its credential store. */
export async function readClaudeSubscriptionStatus(
	options: ClaudeSubscriptionAuthOptions = {},
): Promise<ClaudeSubscriptionStatus> {
	const executable = await findClaudeCodeExecutable(options);
	try {
		const { stdout } = await execFileAsync(
			executable,
			["auth", "status", "--json"],
			{
				env: buildClaudeSubscriptionEnv(),
				timeout: STATUS_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			},
		);
		const parsed = JSON.parse(stdout) as {
			loggedIn?: unknown;
			authMethod?: unknown;
			apiProvider?: unknown;
		};
		return {
			loggedIn: parsed.loggedIn === true,
			authMethod:
				typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
			apiProvider:
				typeof parsed.apiProvider === "string" ? parsed.apiProvider : undefined,
			executable,
		};
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				"Claude Code returned an unreadable authentication status.",
			);
		}
		return { loggedIn: false, executable };
	}
}

export function isClaudeAiSubscriptionStatus(
	status: ClaudeSubscriptionStatus,
): boolean {
	return (
		status.loggedIn &&
		status.authMethod?.toLowerCase() === "claude.ai" &&
		status.apiProvider?.toLowerCase() === "firstparty"
	);
}

export async function assertClaudeSubscriptionLogin(
	options: ClaudeSubscriptionAuthOptions = {},
): Promise<ClaudeSubscriptionStatus> {
	const status = await readClaudeSubscriptionStatus(options);
	if (!isClaudeAiSubscriptionStatus(status)) {
		await forgetClaudeSubscriptionLogin(options);
		throw new ClaudeSubscriptionLoginRequiredError();
	}
	await rememberClaudeSubscriptionLogin(options);
	return status;
}

/**
 * {@link assertClaudeSubscriptionLogin}, skipping the status command while a
 * login verified by this runtime or by the IDE is still within
 * {@link CLAUDE_LOGIN_TRUST_MS}.
 */
export async function assertRecentClaudeSubscriptionLogin(
	options: ClaudeSubscriptionAuthOptions & { now?: number } = {},
): Promise<{ executable: string }> {
	const verifiedAt = await readClaudeLoginRecord(options);
	const now = options.now ?? Date.now();
	if (
		verifiedAt !== undefined &&
		verifiedAt <= now &&
		now - verifiedAt < CLAUDE_LOGIN_TRUST_MS
	) {
		return { executable: await findClaudeCodeExecutable(options) };
	}
	return await assertClaudeSubscriptionLogin(options);
}

/** Clears the verified-login record so the next turn asks Claude Code again. */
export async function forgetClaudeSubscriptionLogin(
	options: Pick<ClaudeSubscriptionAuthOptions, "homeDir"> = {},
): Promise<void> {
	await rm(claudeLoginRecordPath(options.homeDir), { force: true }).catch(
		() => undefined,
	);
}

function claudeLoginRecordPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".backboard", LOGIN_RECORD_FILE);
}

async function readClaudeLoginRecord(
	options: Pick<ClaudeSubscriptionAuthOptions, "homeDir">,
): Promise<number | undefined> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(claudeLoginRecordPath(options.homeDir), "utf8"),
		);
		const verifiedAt =
			typeof parsed === "object" && parsed !== null
				? (parsed as { verifiedAt?: unknown }).verifiedAt
				: undefined;
		return typeof verifiedAt === "number" && Number.isFinite(verifiedAt)
			? verifiedAt
			: undefined;
	} catch {
		return undefined;
	}
}

/** Holds a timestamp only; Claude Code keeps the credentials. */
async function rememberClaudeSubscriptionLogin(
	options: Pick<ClaudeSubscriptionAuthOptions, "homeDir">,
): Promise<void> {
	const file = claudeLoginRecordPath(options.homeDir);
	try {
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(file, JSON.stringify({ verifiedAt: Date.now() }), {
			mode: 0o600,
		});
	} catch {
		// Without the record every turn simply verifies again.
	}
}

/**
 * Delegate OAuth entirely to the official Claude Code executable. Backboard
 * stores only an enable bit; Claude owns token persistence and refresh.
 */
export async function loginWithClaudeSubscription(
	options: ClaudeSubscriptionAuthOptions = {},
): Promise<string> {
	const executable = await findClaudeCodeExecutable(options);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, ["auth", "login", "--claudeai"], {
			env: buildClaudeSubscriptionEnv(),
			stdio: ["inherit", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new Error(
					"Claude sign-in timed out. Choose Connect Claude to try again.",
				),
			);
		}, LOGIN_TIMEOUT_MS);
		timeout.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			process.stdout.write(text);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			process.stderr.write(text);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else {
				reject(
					new Error(
						`Claude sign-in failed: ${(stderr || stdout || `exit code ${code ?? "unknown"}`).trim()}`,
					),
				);
			}
		});
	});

	const message = await enableClaudeSubscription({
		...options,
		executable,
	});
	// Claude Code owns this OAuth flow and its final browser page; finish on
	// Backboard's completion page like the other sign-ins. Best effort only.
	await (options.openBrowser ?? openDefaultBrowser)(
		backboardOAuthCompleteUrl(options.homeDir),
	).catch(() => undefined);
	return message;
}

/** Persist the Backboard enable bit after a non-interactive status check. */
export async function enableClaudeSubscription(
	options: ClaudeSubscriptionAuthOptions = {},
): Promise<string> {
	const status = await assertClaudeSubscriptionLogin(options);
	const config = readBackboardConfig(options.homeDir);
	await saveBackboardConfig(
		{ ...config, claudeSubscriptionEnabled: true },
		options.homeDir,
	);
	return `Claude subscription connected through ${status.executable}.`;
}

/** Disconnect Backboard without signing the user out of Claude Code itself. */
export async function disconnectClaudeSubscription(
	options: Pick<ClaudeSubscriptionAuthOptions, "homeDir"> = {},
): Promise<string> {
	const config = readBackboardConfig(options.homeDir);
	const { claudeSubscriptionEnabled: _removed, ...remaining } = config;
	await saveBackboardConfig(remaining, options.homeDir);
	await forgetClaudeSubscriptionLogin(options);
	return "Claude subscription disconnected from Backboard. Claude Code remains signed in.";
}

export function claudeSubscriptionErrorMessage(error: unknown): string {
	const message = errorMessage(error);
	return /authentication_failed|not logged in|unauthorized|oauth|401/i.test(
		message,
	)
		? new ClaudeSubscriptionLoginRequiredError().message
		: message;
}
