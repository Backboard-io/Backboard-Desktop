import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PROCESS_LIST_LIMIT = 16 * 1024 * 1024;

export function createIsolatedProcessToken(): string {
	return randomUUID();
}

/**
 * macOS process groups are not a containment primitive: a descendant can call
 * setsid() and survive kill(-launcherPid). sandbox-exec is inherited, so that
 * process remains filesystem-sandboxed but may waste resources after the
 * worker ends. Every isolated worker gets an inherited launch token; before
 * finalization we clean up token-bearing descendants, including common runtime
 * processes that create a new session. This is defense in depth on macOS—some
 * native binaries hide their environment from ps—while the read-only checkout
 * remains the hard write boundary. Linux uses a private PID namespace.
 */
export async function terminateIsolatedWorkerProcesses(
	token: string,
): Promise<void> {
	return terminateTaggedProcesses("BACKBOARD_ISOLATED_WORKER_TOKEN", token);
}

export async function terminateIsolatedCommandProcesses(
	token: string,
): Promise<void> {
	return terminateTaggedProcesses("BACKBOARD_ISOLATED_EXEC_TOKEN", token);
}

async function terminateTaggedProcesses(
	variable: string,
	token: string,
): Promise<void> {
	if (process.platform !== "darwin") return;
	const marker = `${variable}=${token}`;
	const uid = process.getuid?.();
	if (uid === undefined) {
		throw new Error("Cannot identify the isolated worker's host user.");
	}
	let emptyPasses = 0;
	for (let pass = 0; pass < 6; pass++) {
		const pids = await findTaggedProcesses(marker, uid);
		if (pids.length === 0) {
			emptyPasses++;
			if (emptyPasses === 2) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			continue;
		}
		emptyPasses = 0;
		if (pass === 5) {
			throw new Error(
				"Could not stop every detached isolated-worker process; refusing to finalize the worker.",
			);
		}
		for (const pid of pids) {
			if (pid === process.pid) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// It exited between ps and kill.
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

function findTaggedProcesses(marker: string, uid: number): Promise<number[]> {
	return new Promise((resolveProcesses, rejectProcesses) => {
		const ps = spawn(
			"/bin/ps",
			["-U", String(uid), "-x", "-E", "-ww", "-o", "pid=,uid=,command="],
			{
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let output = "";
		let stderr = "";
		let overflowed = false;
		let completed = false;
		const finish = (result: { pids: number[] } | { error: Error }): void => {
			if (completed) return;
			completed = true;
			clearTimeout(timer);
			if ("error" in result) rejectProcesses(result.error);
			else resolveProcesses(result.pids);
		};
		const timer = setTimeout(() => {
			ps.kill("SIGKILL");
			finish({ error: new Error("Process listing timed out.") });
		}, 2_000);
		ps.stdout?.on("data", (chunk) => {
			if (overflowed) return;
			output += chunk.toString();
			if (output.length > PROCESS_LIST_LIMIT) {
				overflowed = true;
				output = "";
				ps.kill("SIGKILL");
			}
		});
		ps.stderr?.on("data", (chunk) => {
			if (stderr.length < 4_096) stderr += chunk.toString();
		});
		ps.once("error", (error) => finish({ error }));
		ps.once("close", (code, signal) => {
			if (overflowed) {
				finish({
					error: new Error(
						"Process listing exceeded the isolated-worker safety limit.",
					),
				});
				return;
			}
			if (code !== 0 || signal !== null) {
				finish({
					error: new Error(
						`Process listing failed (${signal ?? `exit ${code ?? "unknown"}`}): ${stderr.trim() || "no details"}`,
					),
				});
				return;
			}
			finish({
				pids: output
					.split("\n")
					.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
					.filter((match): match is RegExpMatchArray => match !== null)
					.filter(
						(match) =>
							Number.parseInt(match[2] ?? "", 10) === uid &&
							(match[3] ?? "").split(/\s+/).includes(marker),
					)
					.map((match) => Number.parseInt(match[1] ?? "", 10))
					.filter(Number.isSafeInteger),
			});
		});
	});
}
