import { rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { JevStaleTargetError } from "./JevSurfaceError.ts";

const CALL_TIMEOUT_MS = 25_000;
/**
 * Reading a very large page is slow: the semantic snapshot of Wikipedia's Alan
 * Turing article measured 3-10 s and once exceeded 25 s. A read changes
 * nothing, so it may wait longer than an action.
 */
const READ_TIMEOUT_MS = 60_000;
const READ_TOOLS = new Set(["get_browser_state", "get_window_state"]);
/** Measured at ~0.5 s; a cold first launch after a build is slower. */
const DAEMON_READY_MS = 10_000;
const DAEMON_STOP_MS = 5_000;
let daemonCount = 0;

/**
 * Daemons still running. Their stdin pipe should end them with this process,
 * but a daemon that had served an MCP connection was measured to outlive a
 * killed parent, so any exit this process gets to see also stops them.
 */
const liveDaemons = new Set<Bun.Subprocess>();
process.once("exit", () => {
	for (const daemon of liveDaemons) daemon.kill("SIGTERM");
});

/**
 * `CUA_DRIVER_EMBEDDED=1` keeps the driver in the spawning app's macOS
 * responsibility chain, so Backboard Studio's Accessibility and Screen
 * Recording grants cover it and no second permission prompt appears.
 */
function driverEnvironment(): Record<string, string> {
	return {
		...getDefaultEnvironment(),
		CUA_DRIVER_EMBEDDED: "1",
		// The driver phones home by default; the contract here is that only what
		// the brain needs to decide ever leaves the machine.
		CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
		CUA_TELEMETRY_ENABLED: "false",
	};
}

/**
 * Every call of a run shares this session, so the agent cursor it shows moves
 * with the run's actions; the cursor's badge shows the name to the user.
 */
export const CUA_SESSION = "Backboard";

/** Tools that take a session. The others reject arguments they do not know. */
const SESSION_TOOLS = new Set([
	"get_window_state",
	"click",
	"type_text",
	"press_key",
	"scroll",
	"set_agent_cursor_enabled",
	"get_browser_state",
	"browser_prepare",
	"browser_navigate",
	"browser_click",
	"browser_type",
	"browser_pointer",
]);

export interface CuaCallOutcome<T> {
	ok: boolean;
	data: T;
	error?: string;
	inputNotDispatched?: boolean;
}

/**
 * One persistent stdio MCP connection to the open-source Cua Driver
 * (https://github.com/trycua/cua, MIT). The driver keeps per-connection state
 * (element tokens, browser targets, and any browser it launched), so a surface
 * holds a single client for its whole life.
 */
export class CuaDriverClient {
	private client: Client | null = null;
	private daemon: {
		process: Bun.Subprocess<"pipe", "ignore", "pipe">;
		socket: string;
	} | null = null;

	constructor(private readonly binaryPath: string) {}

	/** Throws on a tool error or a structured refusal. */
	async call<T>(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<T> {
		const outcome = await this.tryCall<T>(name, args, signal);
		if (!outcome.ok) {
			const message = `cua-driver ${name}: ${outcome.error}`;
			if (outcome.inputNotDispatched) throw new JevStaleTargetError(message);
			throw new Error(message);
		}
		return outcome.data;
	}

	/** For calls whose failure is an expected branch rather than an error. */
	async tryCall<T>(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<CuaCallOutcome<T>> {
		const client = await this.connect(signal);
		const result = await client.callTool(
			{
				name,
				arguments: SESSION_TOOLS.has(name)
					? { session: CUA_SESSION, ...args }
					: args,
			},
			undefined,
			{
				signal,
				// A bounded drawing can contain 4096 points paced at 8ms each.
				timeout:
					name === "browser_pointer" && Array.isArray(args.strokes)
						? 60_000
						: READ_TOOLS.has(name)
							? READ_TIMEOUT_MS
							: CALL_TIMEOUT_MS,
			},
		);
		const data = (result.structuredContent ?? {}) as T & {
			status?: string;
			effect?: string;
			escalation?: { reason?: string };
			refusal?: { code?: string; message?: string };
		};
		if (result.isError) {
			const error = contentText(result.content);
			return {
				ok: false,
				data,
				error,
				inputNotDispatched: isUndispatchedRefusal(error),
			};
		}
		// The browser tools decline with a structured refusal, not a tool error.
		if (data.refusal || data.status === "refused") {
			return {
				ok: false,
				data,
				error: `${data.refusal?.code ?? "refused"}: ${data.refusal?.message ?? ""}`,
				inputNotDispatched:
					data.refusal?.code === "browser_ref_stale" ||
					data.refusal?.code === "browser_input_trust_unavailable" ||
					(data.refusal?.code === "browser_action_unavailable" &&
						data.refusal.message ===
							"click target is no longer visible, enabled, or unobstructed"),
			};
		}
		// A successful call can still report that nothing was done: a trusted
		// click answers `effect: "refused"` when it would have to raise the window.
		// Read as success, that left every click on a real page doing nothing.
		if (data.effect === "refused") {
			return {
				ok: false,
				data,
				error:
					contentText(result.content) ||
					`refused: ${data.escalation?.reason ?? "no effect"}`,
				inputNotDispatched: isUndispatchedRefusal(contentText(result.content)),
			};
		}

		return { ok: true, data };
	}

	/** Closes the connection and stops the daemon, and with it any browser it launched. */
	async close(): Promise<void> {
		const client = this.client;
		this.client = null;
		await client?.close().catch(() => undefined);
		this.stopDaemon();
	}

	private async connect(signal: AbortSignal): Promise<Client> {
		if (this.client) return this.client;
		let socket: string | undefined;
		try {
			socket = await this.startDaemon(signal);
		} catch {
			// Without a daemon the driver still acts, only without its cursor.
			this.stopDaemon();
		}
		if (signal.aborted) throw new Error("aborted");
		const transport = new StdioClientTransport({
			command: this.binaryPath,
			// A proxy to our private daemon. `--direct` runs the tools in this
			// process instead, where macOS allows no cursor overlay.
			args: socket
				? ["mcp", "--embedded", "--socket", socket]
				: ["mcp", "--direct", "--embedded"],
			env: driverEnvironment(),
			stderr: "ignore",
		});
		const client = new Client(
			{ name: "backboard-computer-use", version: "1" },
			{ capabilities: {} },
		);
		try {
			await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
		} catch (error) {
			await client.close().catch(() => undefined);
			this.stopDaemon();
			throw error;
		}
		this.client = client;
		return client;
	}

	/**
	 * The driver's own daemon, spawned by this process so it inherits the app's
	 * permissions. Only the daemon can draw the agent cursor: it runs the AppKit
	 * main thread that the overlay needs.
	 */
	private async startDaemon(signal: AbortSignal): Promise<string> {
		// Under /tmp: a Unix socket path is capped at 104 bytes, and macOS's
		// per-user temp directory alone uses half of that.
		const socket = `/tmp/backboard-cua-${process.pid}-${++daemonCount}.sock`;
		rmSync(socket, { force: true });
		// `--parent-liveness-stdio`: the daemon exits when its stdin closes, which
		// is also what happens if this process dies without stopping it. That
		// needs a real pipe: node:child_process under Bun hands over a socket
		// pair, and a daemon given one outlived a killed parent.
		const child = Bun.spawn(
			[
				this.binaryPath,
				"serve",
				"--embedded",
				"--parent-liveness-stdio",
				"--socket",
				socket,
			],
			{
				env: driverEnvironment(),
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		this.daemon = { process: child, socket };
		liveDaemons.add(child);
		void child.exited.then(() => liveDaemons.delete(child));
		const deadline = Date.now() + DAEMON_READY_MS;
		while (!(await accepts(socket))) {
			if (child.exitCode !== null) {
				const stderr = await new Response(child.stderr).text();
				throw new Error(`cua-driver daemon exited: ${stderr.slice(-600)}`);
			}
			if (Date.now() > deadline || signal.aborted)
				throw new Error("cua-driver daemon did not start in time.");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return socket;
	}

	private stopDaemon(): void {
		const daemon = this.daemon;
		this.daemon = null;
		if (!daemon) return;
		// Closing stdin asks the daemon to shut down, closing the browser it
		// launched on the way out; the signal is only for a daemon that hangs.
		void daemon.process.stdin.end();
		setTimeout(() => {
			if (daemon.process.exitCode === null) daemon.process.kill("SIGTERM");
			rmSync(daemon.socket, { force: true });
		}, DAEMON_STOP_MS).unref();
	}
}

function accepts(socket: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connectSocket(socket);
		probe.once("connect", () => {
			probe.end();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "unknown error";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String(part.text)
				: "",
		)
		.join(" ")
		.slice(0, 400);
}

/** Driver's canonical action projection puts the detailed refusal in text.
 * Only these exact pre-dispatch outcomes permit a new observation/decision. */
export function isUndispatchedRefusal(text: string): boolean {
	return (
		/^refused \(browser_ref_stale\):/.test(text) ||
		// "could not prepare trusted replacement input": nothing was typed.
		/^refused \(browser_input_trust_unavailable\):/.test(text) ||
		text ===
			"refused (browser_action_unavailable): click target is no longer visible, enabled, or unobstructed"
	);
}
