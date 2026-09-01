import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { isDangerousCommand } from "../core/permissions/dangerousCommands.ts";
import { pathsInsideCwd } from "../core/permissions/pathsInside.ts";
import { isSafeCommand } from "../core/permissions/safeCommands.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import {
	createIsolatedProcessToken,
	terminateIsolatedCommandProcesses,
} from "../core/tools/IsolatedProcessTracker.ts";
import { asString, firstLine } from "../core/tools/inputSummary.ts";
import { buildOutputPreview } from "../core/tools/outputPreview.ts";
import { Tool } from "../core/tools/Tool.ts";
import { AbortError } from "../core/tools/ToolAbort.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { assertInsideIsolatedWorkspace } from "../core/tools/WorkspaceBoundary.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { detectCommandShell } from "../utils/commandShell.ts";
import { killProcessTree, treeSpawnOptions } from "../utils/processTree.ts";
import { truncate } from "../utils/string.ts";
import { sanitizeForTerminal } from "../utils/terminalSafe.ts";
import {
	EXECUTE_COMMAND_PREVIEW_LINES,
	EXECUTE_DEFAULT_TIMEOUT_SECONDS,
	EXECUTE_FIRE_AND_FORGET_LOG_PREFIX,
	EXECUTE_MAX_OUTPUT,
	EXECUTE_OUTPUT_PREVIEW_LINES,
} from "./ExecuteTool.constants.ts";

const schema = z.object({
	command: z.string().describe("The command to execute"),
	cwd: z
		.string()
		.optional()
		.describe("Working directory, relative to the session cwd"),
	timeout: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Timeout in seconds (default: 90)"),
	fireAndForget: z
		.boolean()
		.optional()
		.describe(
			"Run command in background without waiting for completion. After start, note the printed PID and temp log path, check process status and logs directly, and stop the process later with kill <pid> if needed.",
		),
});

type Input = z.infer<typeof schema>;

interface Output {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	timedOut?: boolean;
	pid?: number;
	logPath?: string;
	fireAndForget?: boolean;
}

export class ExecuteTool extends Tool<Input, Output> {
	readonly name = "Execute";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override permissionContent(input: Input): string {
		return input.command;
	}

	override checkPermissions(
		input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		// Backgrounded commands detach from output review — never auto-allow.
		// Manual prompts for the safe list too when a human can answer it; a
		// sub-agent or headless run keeps the shortcut, since its "ask" denies.
		if (
			!input.fireAndForget &&
			!(ctx.mode === "manual" && ctx.interactive) &&
			isSafeCommand(input.command)
		) {
			return { behavior: "allow", reason: "safe read-only command" };
		}
		// Auto runs everything except the danger list, backgrounded included —
		// prompting on every dev-server start would defeat the mode.
		if (
			ctx.mode === "auto" &&
			pathsInsideCwd(input.cwd ? [input.cwd] : [], ctx.cwd) &&
			!isDangerousCommand(input.command, ctx.cwd)
		) {
			return { behavior: "allow", reason: "auto mode" };
		}
		return undefined;
	}

	override permissionHint(input: Input): string | undefined {
		const reason = isDangerousCommand(input.command);
		return reason ? `Flagged as risky: ${reason}.` : undefined;
	}

	override summarizeInput(input: Input): string | undefined {
		const command = asString(input.command);
		return command ? firstLine(command) : undefined;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const cwd = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
		assertInsideIsolatedWorkspace(ctx, [cwd]);
		const shell = detectCommandShell();
		if (
			input.fireAndForget &&
			((ctx.agentDepth ?? 0) > 0 || ctx.isolatedWorkspaceRoot)
		) {
			throw new Error(
				"Subagents cannot detach background commands because cancellation must stop every worker process.",
			);
		}
		if (input.fireAndForget)
			return this.startFireAndForget(input.command, cwd, shell.path);

		// Shell commands cannot journal their own pre-images; the checkpoint
		// store snapshots the workspace around the run instead. Rooted at the
		// session cwd (not the command's sub-cwd) so the index covers the whole
		// workspace. Both calls are best-effort and swallow their own errors.
		await ctx.checkpoints?.beginShellCapture(ctx.cwd, ctx);
		try {
			return await this.runCommand(input, ctx, cwd, shell.path);
		} finally {
			await ctx.checkpoints?.endShellCapture(ctx);
		}
	}

	private runCommand(
		input: Input,
		ctx: ToolContext,
		cwd: string,
		shellPath: string,
	): Promise<ToolResult<Output>> {
		if (ctx.signal.aborted) return Promise.reject(new AbortError());
		const timeoutMs = (input.timeout ?? EXECUTE_DEFAULT_TIMEOUT_SECONDS) * 1000;
		const isolatedLauncher = createIsolatedCommandLauncher(
			ctx.isolatedWorkspaceRoot,
			ctx.isolatedScratchRoot,
			ctx.isolatedProcessToken,
			cwd,
			shellPath,
			input.command,
		);

		return new Promise<ToolResult<Output>>((resolvePromise, reject) => {
			// Run the command in its own process group (`detached`) so a timeout
			// or abort can terminate the whole tree the shell spawns, not just the
			// shell. Without this, a child that outlives a SIGTERM to the shell can
			// keep an stdio pipe open and the `close` event never fires.
			const child = isolatedLauncher
				? spawn(isolatedLauncher.file, isolatedLauncher.args, {
						cwd,
						env: isolatedLauncher.env,
						...treeSpawnOptions(),
					})
				: spawn(input.command, {
						cwd,
						shell: shellPath,
						...treeSpawnOptions(),
					});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let abortPending = false;
			let exitCode: number | null = null;
			let settled = false;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			let closeGrace: ReturnType<typeof setTimeout> | undefined;

			const signalTree = (signal: NodeJS.Signals) =>
				killProcessTree(child, signal);

			// Terminate gracefully, then force-kill if it does not exit promptly.
			// The escalation timer is left running on settle so stragglers still
			// get the SIGKILL; it is unref'd and a no-op once the group is gone.
			const terminate = () => {
				signalTree("SIGTERM");
				escalation = setTimeout(() => signalTree("SIGKILL"), 2_000);
				escalation.unref?.();
			};

			const timer = setTimeout(() => {
				timedOut = true;
				if (isolatedLauncher) signalTree("SIGKILL");
				else terminate();
			}, timeoutMs);

			const onAbort = () => {
				if (isolatedLauncher) {
					// Worker code is untrusted and can trap SIGTERM, write after the
					// tool has returned, and race result capture. Force-kill first and
					// wait for exit/close before allowing integration to continue.
					abortPending = true;
					signalTree("SIGKILL");
					return;
				}
				terminate();
				settle(() => reject(new AbortError()));
			};
			ctx.signal.addEventListener("abort", onAbort, { once: true });

			const settle = (finish: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (closeGrace) clearTimeout(closeGrace);
				ctx.signal.removeEventListener("abort", onAbort);
				// Detach from a surviving background child's pipes without killing it.
				detachStream(child.stdout);
				detachStream(child.stderr);
				// A macOS child can start a new process group and escape kill(-pid).
				// Wait for token-tagged descendants to be gone before result capture or
				// worker integration can observe a supposedly finished command.
				void (async () => {
					try {
						await isolatedLauncher?.terminateDetachedProcesses();
						await isolatedLauncher?.cleanup();
						finish();
					} catch (error) {
						await isolatedLauncher?.cleanup();
						reject(error);
					}
				})();
			};

			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
				if (stdout.length > EXECUTE_MAX_OUTPUT) {
					stdout = stdout.slice(0, EXECUTE_MAX_OUTPUT);
				}
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
				if (stderr.length > EXECUTE_MAX_OUTPUT) {
					stderr = stderr.slice(0, EXECUTE_MAX_OUTPUT);
				}
			});

			const resolveResult = (): void => {
				if (abortPending) {
					settle(() => reject(new AbortError()));
					return;
				}
				settle(() => {
					const out = {
						exitCode: exitCode ?? (timedOut ? 124 : 1),
						stdout,
						stderr,
						timedOut,
					};
					resolvePromise(
						ok(
							out,
							buildOutput(out),
							formatResultTitle(out),
							buildExecuteDetail(input.command, out),
						),
					);
				});
			};

			child.on("error", (err) =>
				settle(() => reject(abortPending ? new AbortError() : err)),
			);

			child.on("exit", (code) => {
				// After an abort/error settle, nothing would ever clear this timer.
				if (settled) return;
				exitCode = code;
				// A descendant can close or redirect stdio, causing `close` to fire
				// before the grace timer. Kill the isolated process group immediately
				// when its supervising shell exits so that path cannot detach work.
				if (isolatedLauncher) signalTree("SIGKILL");
				// Surviving children can hold the stdio pipes open; don't wait
				// on "close" forever once the shell itself is gone.
				closeGrace = setTimeout(resolveResult, CLOSE_GRACE_MS);
			});

			child.on("close", resolveResult);
		});
	}

	private startFireAndForget(
		command: string,
		cwd: string,
		shellPath: string,
	): Promise<ToolResult<Output>> {
		const logDir = join(tmpdir(), "backboard-r-cli");
		mkdirSync(logDir, { recursive: true });
		const logPath = join(
			logDir,
			`${EXECUTE_FIRE_AND_FORGET_LOG_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
		);
		const stdoutFd = openSync(logPath, "a");
		const stderrFd = openSync(logPath, "a");
		try {
			const child = spawn(command, {
				cwd,
				shell: shellPath,
				detached: true,
				windowsHide: true,
				stdio: ["ignore", stdoutFd, stderrFd],
			});
			child.unref();
			const pid = child.pid;
			if (pid === undefined)
				throw new Error("background command did not start");
			const output = `started background command\npid: ${pid}\nlog path: ${logPath}`;
			return Promise.resolve(
				ok({ pid, logPath, fireAndForget: true }, output, `Started PID ${pid}`),
			);
		} finally {
			closeSync(stdoutFd);
			closeSync(stderrFd);
		}
	}
}

const CLOSE_GRACE_MS = 1_000;

interface IsolatedCommandLauncher {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	terminateDetachedProcesses(): Promise<void>;
	cleanup(): Promise<void>;
}

/**
 * Shell text can hide writes inside interpreters, package scripts, command
 * substitutions, and binaries we have never seen before. Path heuristics are
 * therefore not a security boundary. Isolated workers run their shell under
 * the host OS filesystem sandbox: the checkout and the rest of the machine are
 * read-only, while one private worker scratch/cache directory is writable.
 * Source changes must use Write/Edit/ApplyPatch, whose paths are validated and
 * journaled. This also means a native process that detaches from the shell on
 * macOS cannot race integration with a late checkout write. When no supported
 * sandbox exists, Execute fails closed and purpose-built tools remain available.
 */
function createIsolatedCommandLauncher(
	workspaceRoot: string | undefined,
	sharedScratchRoot: string | undefined,
	sharedProcessToken: string | undefined,
	cwd: string,
	shellPath: string,
	command: string,
): IsolatedCommandLauncher | undefined {
	if (!workspaceRoot) return undefined;

	const sandboxExec =
		process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
			? "/usr/bin/sandbox-exec"
			: undefined;
	const bubblewrap =
		process.platform === "linux" ? usableBubblewrap() : undefined;
	if (!sandboxExec && !bubblewrap) {
		throw new Error(
			"This isolated worker cannot run shell commands because no supported filesystem sandbox is available. Use Read, Grep, Glob, Write, Edit, or ApplyPatch inside the worker checkout instead.",
		);
	}

	const ownsScratch = !sharedScratchRoot;
	const sandboxTemp = realpathSync(
		sharedScratchRoot ?? mkdtempSync(join(tmpdir(), "backboard-worker-exec-")),
	);
	const processToken = createIsolatedProcessToken();
	const workerToken = sharedProcessToken ?? processToken;
	const writablePaths = [sandboxTemp];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		BACKBOARD_ISOLATED_EXEC_TOKEN: processToken,
		BACKBOARD_ISOLATED_WORKER_TOKEN: workerToken,
		HOME: sandboxTemp,
		TMPDIR: sandboxTemp,
		TMP: sandboxTemp,
		TEMP: sandboxTemp,
		XDG_CACHE_HOME: join(sandboxTemp, "cache"),
		XDG_CONFIG_HOME: join(sandboxTemp, "config"),
		XDG_RUNTIME_DIR: join(sandboxTemp, "runtime"),
		npm_config_cache: join(sandboxTemp, "npm-cache"),
		BUN_INSTALL_CACHE_DIR: join(sandboxTemp, "bun-cache"),
		DOCKER_HOST: undefined,
		CONTAINER_HOST: undefined,
		DBUS_SESSION_BUS_ADDRESS: undefined,
		SSH_AUTH_SOCK: undefined,
		// Read-only Git commands do not need to refresh the linked worktree's
		// index. The worker's Git administrative directory deliberately stays
		// read-only; result capture is owned by WorkerWorkspaceManager.
		GIT_OPTIONAL_LOCKS: "0",
	};
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned || !ownsScratch) return;
		cleaned = true;
		try {
			await rm(sandboxTemp, { recursive: true, force: true });
		} catch {
			// A force-killed child can briefly retain a temp handle. The OS temp
			// cleaner can safely reclaim this private directory later.
		}
	};

	if (sandboxExec) {
		const exceptions = [
			...writablePaths.map(
				(path) => `(require-not (subpath ${JSON.stringify(path)}))`,
			),
			'(require-not (literal "/dev/null"))',
			'(require-not (literal "/dev/tty"))',
		].join(" ");
		// Host daemons (Docker/Podman included) can perform writes on behalf of a
		// sandboxed client. Deny socket/network access as well as direct writes so
		// Execute cannot proxy a mutation around the filesystem boundary.
		const profile = `(version 1) (allow default) (deny network*) (deny file-write* (require-all ${exceptions}))`;
		return {
			file: sandboxExec,
			args: ["-p", profile, shellPath, "-c", command],
			env,
			terminateDetachedProcesses: () =>
				terminateIsolatedCommandProcesses(processToken),
			cleanup,
		};
	}

	return {
		file: bubblewrap as string,
		args: [
			"--die-with-parent",
			"--unshare-pid",
			"--unshare-net",
			"--new-session",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			// Hide host runtime and temp sockets. A private network namespace alone
			// does not isolate AF_UNIX sockets reachable through the filesystem.
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/tmp",
			"--dir",
			sandboxTemp,
			"--bind",
			sandboxTemp,
			sandboxTemp,
			"--chdir",
			cwd,
			"--",
			shellPath,
			"-c",
			command,
		],
		env,
		terminateDetachedProcesses: () =>
			terminateIsolatedCommandProcesses(processToken),
		cleanup,
	};
}

let cachedBubblewrap: string | null | undefined;

/** Locate and capability-probe bubblewrap once; installed is not usable. */
function usableBubblewrap(): string | undefined {
	if (cachedBubblewrap !== undefined) return cachedBubblewrap ?? undefined;
	const candidates = [
		...(process.env.PATH ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((entry) => join(entry, "bwrap")),
		"/usr/bin/bwrap",
		"/bin/bwrap",
	].filter((value, index, values) => values.indexOf(value) === index);
	const candidate = candidates.find(existsSync);
	if (!candidate) {
		cachedBubblewrap = null;
		return undefined;
	}
	const probe = spawnSync(
		candidate,
		[
			"--die-with-parent",
			"--unshare-pid",
			"--unshare-net",
			"--new-session",
			"--ro-bind",
			"/",
			"/",
			"--proc",
			"/proc",
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/tmp",
			"--",
			"/bin/true",
		],
		{ stdio: "ignore", timeout: 2_000 },
	);
	cachedBubblewrap = probe.status === 0 ? candidate : null;
	return cachedBubblewrap ?? undefined;
}

// Keep draining and discarding (never pause) so a surviving background child
// can't block on a full pipe buffer; unref so the stream can't hold the CLI
// open; swallow any late pipe error now that nothing else is listening.
// Destroying instead would SIGPIPE-kill the child on its next write.
function detachStream(stream: Readable | null): void {
	if (!stream) return;
	stream.removeAllListeners("data");
	stream.on("error", () => {});
	stream.resume();
	(stream as { unref?: () => void }).unref?.();
}

function formatResultTitle(out: Output): string {
	if (out.exitCode === 0 && !out.timedOut) return "Success";
	const message = firstOutputLine(out.stderr) ?? firstOutputLine(out.stdout);
	if (out.timedOut) return message ? `Timed out: ${message}` : "Timed out";
	return message ? `Failed: ${message}` : "Failed";
}

// Piped output is usually colorless, but FORCE_COLOR/CLICOLOR_FORCE can emit
// SGR codes; strip them so the blind 160-char truncate can't bisect a sequence
// and bleed styling into the transcript rows below the title.
function firstOutputLine(value: string | undefined): string | undefined {
	// First non-blank line, without materializing every line of 40KB output.
	const raw = value?.match(/^[ \t]*(\S[^\r\n]*)/m)?.[1];
	if (!raw) return undefined;
	const line = sanitizeForTerminal(raw).trim();
	return line ? truncate(line, 160) : undefined;
}

// A multi-line transcript preview: the command being run, then a truncated
// window of stdout and stderr, so a call shows what it did instead of a bare
// Success/Failed line. Full output still goes to the model via buildOutput.
function buildExecuteDetail(command: string, out: Output): string | undefined {
	const sections: string[] = [];
	const cmd = promptifyCommand(command);
	if (cmd) sections.push(cmd);
	const stdout = buildOutputPreview(out.stdout, {
		maxLines: EXECUTE_OUTPUT_PREVIEW_LINES,
	});
	if (stdout) sections.push(`stdout:\n${stdout}`);
	const stderr = buildOutputPreview(out.stderr, {
		maxLines: EXECUTE_OUTPUT_PREVIEW_LINES,
	});
	if (stderr) sections.push(`stderr:\n${stderr}`);
	return sections.length ? sections.join("\n") : undefined;
}

// Render the command as a shell prompt: "$ " on the first line, hanging-indented
// continuation lines, capped to a handful of lines so a heredoc can't flood the
// transcript.
function promptifyCommand(command: string): string | undefined {
	const preview = buildOutputPreview(command, {
		maxLines: EXECUTE_COMMAND_PREVIEW_LINES,
	});
	if (!preview) return undefined;
	return preview
		.split("\n")
		.map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`))
		.join("\n");
}

function buildOutput(out: Output): string {
	const parts: string[] = [];
	if (out.timedOut) parts.push("[timed out]");
	parts.push(`exit code: ${out.exitCode}`);
	if (out.stdout) parts.push(`stdout:\n${out.stdout}`);
	if (out.stderr) parts.push(`stderr:\n${out.stderr}`);
	return parts.join("\n");
}
