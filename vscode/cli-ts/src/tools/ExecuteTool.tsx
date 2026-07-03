import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { detectCommandShell } from "../utils/commandShell.ts";
import {
	EXECUTE_DEFAULT_TIMEOUT_SECONDS,
	EXECUTE_FIRE_AND_FORGET_LOG_PREFIX,
	EXECUTE_MAX_OUTPUT,
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

	override execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const cwd = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const shell = detectCommandShell();
		if (input.fireAndForget)
			return this.startFireAndForget(input.command, cwd, shell.path);

		const timeoutMs = (input.timeout ?? EXECUTE_DEFAULT_TIMEOUT_SECONDS) * 1000;

		return new Promise<ToolResult<Output>>((resolvePromise, reject) => {
			if (ctx.signal.aborted) {
				reject(new Error("aborted"));
				return;
			}

			// Run the command in its own process group (`detached`) so a timeout
			// or abort can terminate the whole tree the shell spawns, not just the
			// shell. Without this, a child that outlives a SIGTERM to the shell can
			// keep an stdio pipe open and the `close` event never fires.
			const child = spawn(input.command, {
				cwd,
				shell: shell.path,
				detached: true,
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let escalation: ReturnType<typeof setTimeout> | undefined;

			// Send a signal to the whole process group; fall back to the child
			// alone if the group is already gone or grouping is unavailable.
			const signalTree = (signal: NodeJS.Signals) => {
				const pid = child.pid;
				if (pid === undefined) return;
				try {
					process.kill(-pid, signal);
				} catch {
					try {
						child.kill(signal);
					} catch {
						// process already exited
					}
				}
			};

			// Terminate gracefully, then force-kill if it does not exit promptly.
			const terminate = () => {
				signalTree("SIGTERM");
				escalation = setTimeout(() => signalTree("SIGKILL"), 2_000);
				escalation.unref?.();
			};

			const timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);

			const onAbort = () => {
				aborted = true;
				terminate();
			};
			ctx.signal.addEventListener("abort", onAbort, { once: true });

			const cleanup = () => {
				clearTimeout(timer);
				if (escalation) clearTimeout(escalation);
				ctx.signal.removeEventListener("abort", onAbort);
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

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (aborted) {
					reject(new Error("aborted"));
					return;
				}
				reject(err);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (aborted) {
					reject(new Error("aborted"));
					return;
				}
				const exitCode = code ?? (timedOut ? 124 : 1);
				const forLLM = buildOutput({ exitCode, stdout, stderr, timedOut });
				resolvePromise(
					ok(
						{ exitCode, stdout, stderr, timedOut },
						forLLM,
						timedOut ? `Timed out · exit ${exitCode}` : `Exited ${exitCode}`,
					),
				);
			});
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

function buildOutput(out: Output): string {
	const parts: string[] = [];
	if (out.timedOut) parts.push("[timed out]");
	parts.push(`exit code: ${out.exitCode}`);
	if (out.stdout) parts.push(`stdout:\n${out.stdout}`);
	if (out.stderr) parts.push(`stderr:\n${out.stderr}`);
	return parts.join("\n");
}
