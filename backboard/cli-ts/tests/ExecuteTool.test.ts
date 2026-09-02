import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { makeContext } from "./helpers.ts";

describe("ExecuteTool process management", () => {
	it("streams a live terminal transcript and retains the full result", async () => {
		const bus = new EventBus();
		const streamed: string[] = [];
		bus.on("tool:progress", (event) => {
			if (
				event.data &&
				typeof event.data === "object" &&
				(event.data as { kind?: unknown }).kind === "terminal-output"
			) {
				streamed.push((event.data as { text: string }).text);
			}
		});
		const result = await new ExecuteTool().execute(
			{ command: "printf first; sleep 0.1; printf second" },
			{
				...makeContext(new AbortController().signal, bus),
				toolCallId: "execute-stream",
			},
		);

		expect(streamed.join("")).toBe("firstsecond");
		expect(result.terminalOutput).toEqual({
			text: "firstsecond",
			exitCode: 0,
			timedOut: false,
			truncated: false,
		});
	});

	it("rejects a command cwd outside an isolated worker worktree", async () => {
		const tool = new ExecuteTool();
		await expect(
			tool.execute(
				{ command: "pwd", cwd: "/coordinator" },
				{
					...makeContext(new AbortController().signal),
					cwd: "/worker-worktree",
					isolatedWorkspaceRoot: "/worker-worktree",
				},
			),
		).rejects.toThrow("only write inside their Git worktree");
	});

	it("keeps shell commands read-only inside an isolated worker worktree", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-inside-"));
		try {
			const result = await new ExecuteTool().execute(
				{ command: "mkdir -p nested && printf inside > nested/value.txt" },
				{
					...makeContext(new AbortController().signal),
					cwd: worker,
					isolatedWorkspaceRoot: worker,
				},
			);

			expect(result.data.exitCode).not.toBe(0);
			await expect(access(join(worker, "nested/value.txt"))).rejects.toThrow();
		} catch (error) {
			// Hosts without sandbox-exec/bubblewrap deliberately fail closed.
			expect(String(error)).toContain("no supported filesystem sandbox");
		} finally {
			await rm(worker, { recursive: true, force: true });
		}
	});

	it("blocks shell and interpreter writes outside an isolated worktree", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-boundary-"));
		const outside = await mkdtemp(join(tmpdir(), "execute-worker-outside-"));
		try {
			const escapedDirectory = join(outside, "mkdir-escape");
			const escapedFile = join(outside, "interpreter-escape.txt");
			const script = `require("node:fs").writeFileSync(${JSON.stringify(escapedFile)}, "escaped")`;
			const commands = [
				`mkdir -p ${JSON.stringify(escapedDirectory)}`,
				`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
			];

			for (const command of commands) {
				try {
					const result = await new ExecuteTool().execute(
						{ command },
						{
							...makeContext(new AbortController().signal),
							cwd: worker,
							isolatedWorkspaceRoot: worker,
						},
					);
					expect(result.data.exitCode).not.toBe(0);
				} catch (error) {
					// Hosts without an OS sandbox reject write-capable Execute calls.
					expect(String(error)).toContain("no supported filesystem sandbox");
				}
			}

			await expect(access(escapedDirectory)).rejects.toThrow();
			await expect(access(escapedFile)).rejects.toThrow();
		} finally {
			await rm(worker, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("does not let an isolated worker detach a background writer", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-detach-"));
		try {
			try {
				const result = await new ExecuteTool().execute(
					{
						command:
							"(sleep 1; printf late > detached-result.txt) >/dev/null 2>&1 & echo started",
					},
					{
						...makeContext(new AbortController().signal),
						cwd: worker,
						isolatedWorkspaceRoot: worker,
					},
				);
				expect(result.data.stdout?.trim()).toBe("started");
			} catch (error) {
				expect(String(error)).toContain("no supported filesystem sandbox");
			}
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			await expect(
				access(join(worker, "detached-result.txt")),
			).rejects.toThrow();
		} finally {
			await rm(worker, { recursive: true, force: true });
		}
	}, 5_000);

	it("kills an isolated Node child that creates a new process group", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-new-pgid-"));
		try {
			const escapedFile = join(worker, "detached-node-result.txt");
			const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(escapedFile)}, "late"), 1000); setTimeout(() => {}, 10000);`;
			const launcherScript = `const { spawn } = require("node:child_process"); const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), detached: true, stdio: "ignore" }); child.unref();`;
			try {
				const result = await new ExecuteTool().execute(
					{
						command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(launcherScript)}`,
					},
					{
						...makeContext(new AbortController().signal),
						cwd: worker,
						isolatedWorkspaceRoot: worker,
					},
				);
				expect(result.data.exitCode).toBe(0);
			} catch (error) {
				expect(String(error)).toContain("no supported filesystem sandbox");
			}
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			await expect(access(escapedFile)).rejects.toThrow();
		} finally {
			await rm(worker, { recursive: true, force: true });
		}
	}, 5_000);

	it("cleans a detached child for a real shared worker context", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-shared-"));
		const scratch = await mkdtemp(join(tmpdir(), "execute-worker-shared-tmp-"));
		try {
			const escapedFile = join(scratch, "late-scratch-write.txt");
			const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(escapedFile)}, "alive"), 750); setTimeout(() => {}, 10000);`;
			const launcherScript = `const { spawn } = require("node:child_process"); const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" }); child.unref();`;
			const result = await new ExecuteTool().execute(
				{
					command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(launcherScript)}`,
				},
				{
					...makeContext(new AbortController().signal),
					cwd: worker,
					isolatedWorkspaceRoot: worker,
					isolatedScratchRoot: scratch,
					isolatedProcessToken: "shared-worker-token",
				},
			);
			expect(result.data.exitCode).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			await expect(access(escapedFile)).rejects.toThrow();
		} finally {
			await rm(worker, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	}, 5_000);

	if (process.platform === "darwin") {
		it("blocks a late write from a detached native macOS process", async () => {
			const worker = await mkdtemp(join(tmpdir(), "execute-worker-native-"));
			try {
				const escapedFile = join(worker, "native-late.txt");
				const appleScript = `delay 1\ndo shell script ("printf late > " & quoted form of ${JSON.stringify(escapedFile)})`;
				const launcherScript = `const { spawn } = require("node:child_process"); const child = spawn("/usr/bin/osascript", ["-e", ${JSON.stringify(appleScript)}], { detached: true, stdio: "ignore" }); child.unref();`;
				const result = await new ExecuteTool().execute(
					{
						command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(launcherScript)}`,
					},
					{
						...makeContext(new AbortController().signal),
						cwd: worker,
						isolatedWorkspaceRoot: worker,
					},
				);
				expect(result.data.exitCode).toBe(0);
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				await expect(access(escapedFile)).rejects.toThrow();
			} finally {
				await rm(worker, { recursive: true, force: true });
			}
		}, 5_000);

		const dockerPath = spawnSync("/usr/bin/which", ["docker"], {
			encoding: "utf8",
		}).stdout.trim();
		const dockerDaemonAvailable =
			dockerPath.length > 0 &&
			spawnSync(dockerPath, ["version", "--format", "{{.Server.Version}}"], {
				stdio: "ignore",
			}).status === 0;
		if (dockerDaemonAvailable) {
			it("cannot proxy checkout writes through the host Docker daemon", async () => {
				const worker = await mkdtemp(join(tmpdir(), "execute-worker-docker-"));
				try {
					const result = await new ExecuteTool().execute(
						{
							command: `${JSON.stringify(dockerPath)} version --format '{{.Server.Version}}'`,
						},
						{
							...makeContext(new AbortController().signal),
							cwd: worker,
							isolatedWorkspaceRoot: worker,
						},
					);
					expect(result.data.exitCode).not.toBe(0);
				} finally {
					await rm(worker, { recursive: true, force: true });
				}
			});
		}
	}

	it("reuses a worker-owned shell cache across commands", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-cache-"));
		const scratch = await mkdtemp(join(tmpdir(), "execute-worker-scratch-"));
		const ctx = {
			...makeContext(new AbortController().signal),
			cwd: worker,
			isolatedWorkspaceRoot: worker,
			isolatedScratchRoot: scratch,
		};
		try {
			try {
				await new ExecuteTool().execute(
					{
						command:
							'mkdir -p "$npm_config_cache" && printf warm > "$npm_config_cache/probe"',
					},
					ctx,
				);
				const result = await new ExecuteTool().execute(
					{ command: 'cat "$npm_config_cache/probe"' },
					ctx,
				);
				expect(result.data.stdout).toBe("warm");
			} catch (error) {
				expect(String(error)).toContain("no supported filesystem sandbox");
			}
			await access(scratch);
		} finally {
			await rm(worker, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("waits for an isolated process to be force-killed before abort settles", async () => {
		const worker = await mkdtemp(join(tmpdir(), "execute-worker-abort-"));
		try {
			const controller = new AbortController();
			const pending = new ExecuteTool().execute(
				{
					command:
						'trap "" TERM; sleep 1; printf late > after-abort.txt; sleep 10',
				},
				{
					...makeContext(controller.signal),
					cwd: worker,
					isolatedWorkspaceRoot: worker,
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			await expect(pending).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			await expect(access(join(worker, "after-abort.txt"))).rejects.toThrow();
		} finally {
			await rm(worker, { recursive: true, force: true });
		}
	}, 5_000);

	it("settles once the shell exits even if a background child holds stdio", async () => {
		const tool = new ExecuteTool();
		const started = Date.now();
		const result = await tool.execute(
			{ command: "sleep 15 & echo started" },
			makeContext(new AbortController().signal),
		);

		expect(result.data.stdout?.trim()).toBe("started");
		expect(result.data.exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 10_000);

	it("kills the whole process tree on timeout", async () => {
		const tool = new ExecuteTool();
		const started = Date.now();
		const result = await tool.execute(
			{ command: "sleep 30; echo done", timeout: 1 },
			makeContext(new AbortController().signal),
		);

		expect(result.data.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 10_000);

	it("rejects promptly on abort even after the shell has exited", async () => {
		const tool = new ExecuteTool();
		const controller = new AbortController();
		const pending = tool.execute(
			{ command: "sleep 15 & echo hi" },
			makeContext(controller.signal),
		);

		// Let the shell exit first; only the background child survives.
		await new Promise((r) => setTimeout(r, 500));
		const started = Date.now();
		controller.abort();

		expect(pending).rejects.toThrow();
		await pending.catch(() => {});
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 10_000);
});
