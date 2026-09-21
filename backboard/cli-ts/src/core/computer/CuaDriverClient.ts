import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { JevStaleTargetError } from "./JevSurfaceError.ts";

const CALL_TIMEOUT_MS = 25_000;

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
		const result = await client.callTool({ name, arguments: args }, undefined, {
			signal,
			timeout: CALL_TIMEOUT_MS,
		});
		const data = (result.structuredContent ?? {}) as T & {
			status?: string;
			effect?: string;
			escalation?: { reason?: string };
			refusal?: { code?: string; message?: string };
		};
		if (result.isError) {
			return { ok: false, data, error: contentText(result.content) };
		}
		// The browser tools decline with a structured refusal, not a tool error.
		if (data.refusal || data.status === "refused") {
			return {
				ok: false,
				data,
				error: `${data.refusal?.code ?? "refused"}: ${data.refusal?.message ?? ""}`,
				inputNotDispatched:
					data.refusal?.code === "browser_ref_stale" ||
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
				error: contentText(result.content) || `refused: ${data.escalation?.reason ?? "no effect"}`,
				inputNotDispatched: isUndispatchedRefusal(contentText(result.content)),
			};
		}

		return { ok: true, data };
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = null;
		await client?.close().catch(() => undefined);
	}

	private async connect(signal: AbortSignal): Promise<Client> {
		if (this.client) return this.client;
		const transport = new StdioClientTransport({
			command: this.binaryPath,
			// `--direct`: no shared daemon or socket. `--embedded`: macOS attributes
			// Accessibility to Backboard Studio, so there is no second TCC prompt.
			args: ["mcp", "--direct", "--embedded"],
			env: {
				...getDefaultEnvironment(),
				// The driver phones home by default; the contract here is that only
				// what Jev needs to decide ever leaves the machine.
				CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
				CUA_TELEMETRY_ENABLED: "false",
			},
			stderr: "ignore",
		});
		const client = new Client(
			{ name: "backboard-jev-use", version: "1" },
			{ capabilities: {} },
		);
		try {
			await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
		this.client = client;
		return client;
	}
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
	return /^refused \(browser_ref_stale\):/.test(text) || text === "refused (browser_action_unavailable): click target is no longer visible, enabled, or unobstructed";
}
