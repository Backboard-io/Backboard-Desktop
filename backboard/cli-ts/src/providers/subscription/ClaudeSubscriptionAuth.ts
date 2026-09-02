import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../../config/backboardConfig.ts";
import { errorMessage } from "../../utils/errors.ts";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

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
		throw new ClaudeSubscriptionLoginRequiredError();
	}
	return status;
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

	return enableClaudeSubscription({
		...options,
		executable,
	});
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
