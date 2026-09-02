import { z } from "zod";
import { shortId } from "../../utils/id.ts";
import type { EventBus } from "../bus/EventBus.ts";
import { ImageContent } from "../image/ImageContent.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../permissions/types.ts";
import type { OpenAITool } from "./schema.ts";
import { Tool } from "./Tool.ts";
import type { ToolContext } from "./ToolContext.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";
import { ok, type ToolResult } from "./ToolResult.ts";

/** A tool definition provided by the connected IDE client for one turn. */
export interface ClientToolDefinition {
	name: string;
	description?: string;
	/** JSON Schema for the tool input, advertised to the model verbatim. */
	inputSchema?: Record<string, unknown>;
}

export type ClientToolResultContent =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; dataBase64: string }
	| { type: "resource"; mimeType?: string; dataBase64: string };

/** The IDE's answer to a `client_tool:call` event. */
export interface ClientToolResultPayload {
	success?: boolean;
	content?: ClientToolResultContent[];
	error?: string;
}

const CLIENT_TOOL_TIMEOUT_MS = 300_000;
const INTERACTIVE_BROWSER_TOOL_TIMEOUT_MS = 60_000;

function clientToolTimeoutMs(name: string): number {
	// Opening a browser page is normally a sub-second IDE operation, but it can
	// wait on an approval card. Five silent minutes made a missed/hidden card
	// look like a frozen agent. Fail this interactive hop promptly so the model
	// can fall back to headless verification; keep the longer ceiling for IDE
	// tasks whose legitimate execution can take several minutes.
	return name === "openBrowserPage" || name === "open_browser_page"
		? INTERACTIVE_BROWSER_TOOL_TIMEOUT_MS
		: CLIENT_TOOL_TIMEOUT_MS;
}

interface PendingClientCall {
	resolve: (payload: ClientToolResultPayload) => void;
	reject: (err: Error) => void;
}

/**
 * Bridges IDE-provided ("client") tools into the local tool registry. The
 * model sees them as ordinary tools; execution round-trips through the serve
 * transport: a `client_tool:call` event goes out, the IDE runs the real tool
 * (integrated browser, tasks, tests, …) and answers with a `clientToolResult`
 * control op that releases the parked execution.
 */
export class ClientToolBridge {
	private readonly pending = new Map<string, PendingClientCall>();
	private readonly registeredNames = new Set<string>();

	constructor(
		private readonly bus: EventBus,
		private readonly registry: ToolRegistry,
	) {}

	/**
	 * Replace the registered client tools with `definitions`. Names that
	 * collide with local tools are skipped — the local implementation wins.
	 */
	setTools(definitions: readonly ClientToolDefinition[]): void {
		const wanted = new Map(
			definitions
				.filter((definition) => definition.name?.trim().length > 0)
				.map((definition) => [definition.name, definition] as const),
		);
		for (const name of [...this.registeredNames]) {
			if (!wanted.has(name)) {
				this.registry.unregister(name);
				this.registeredNames.delete(name);
			}
		}
		for (const [name, definition] of wanted) {
			if (this.registeredNames.has(name)) {
				// Re-register so description/schema updates take effect.
				this.registry.unregister(name);
				this.registeredNames.delete(name);
			}
			if (this.registry.has(name)) {
				this.bus.emit({
					type: "system:warning",
					message: `Client tool "${name}" collides with a local tool and was skipped.`,
				});
				continue;
			}
			this.registry.register(new ClientProxyTool(definition, this));
			this.registeredNames.add(name);
		}
	}

	/** Resolve a parked call with the IDE's result. Unknown ids are ignored. */
	provideResult(toolCallId: string, payload: ClientToolResultPayload): void {
		const pending = this.pending.get(toolCallId);
		if (!pending) return;
		this.pending.delete(toolCallId);
		pending.resolve(payload);
	}

	async invoke(
		name: string,
		input: unknown,
		ctx: ToolContext,
	): Promise<ClientToolResultPayload> {
		const toolCallId = ctx.toolCallId ?? shortId("ctc");
		return await new Promise<ClientToolResultPayload>((resolve, reject) => {
			const timeoutMs = clientToolTimeoutMs(name);
			const timer = setTimeout(() => {
				finish();
				reject(
					new Error(
						`The IDE did not complete the "${name}" tool call within ${timeoutMs / 1000}s. It may still be waiting for approval; continue without it and do not retry automatically.`,
					),
				);
			}, timeoutMs);
			const onAbort = (): void => {
				finish();
				reject(new Error("aborted"));
			};
			const finish = (): void => {
				clearTimeout(timer);
				ctx.signal.removeEventListener("abort", onAbort);
				this.pending.delete(toolCallId);
			};
			if (ctx.signal.aborted) {
				onAbort();
				return;
			}
			ctx.signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(toolCallId, {
				resolve: (payload) => {
					finish();
					resolve(payload);
				},
				reject: (err) => {
					finish();
					reject(err);
				},
			});
			// Register before emitting. An in-process IDE adapter or test harness can
			// answer synchronously from its event listener; emitting first would lose
			// that response and leave the call parked until its timeout.
			this.bus.emit({ type: "client_tool:call", toolCallId, name, input });
		});
	}

	/** Fail every parked call (process teardown, turn hand-off). */
	rejectAll(reason: string): void {
		for (const [toolCallId, pending] of [...this.pending]) {
			this.pending.delete(toolCallId);
			pending.reject(new Error(reason));
		}
	}
}

const clientToolInputSchema = z.record(z.unknown());

/**
 * Registry stand-in for one IDE-provided tool. Executing it parks on the
 * {@link ClientToolBridge} until the IDE reports the real tool's result.
 */
export class ClientProxyTool extends Tool<Record<string, unknown>, unknown> {
	/** Marker consulted by sub-agent tool selection: client tools need the IDE round-trip and are not delegatable. */
	readonly isClientProxy = true;
	readonly name: string;
	readonly inputSchema = clientToolInputSchema as z.ZodType<
		Record<string, unknown>
	>;

	constructor(
		private readonly definition: ClientToolDefinition,
		private readonly bridge: ClientToolBridge,
	) {
		super();
		this.name = definition.name;
	}

	override prompt(): string {
		return this.definition.description ?? "";
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	/**
	 * The IDE side owns confirmation for these calls (each tool ships its own
	 * confirmation UX there), so everywhere except strict manual mode the
	 * local gate defers. Deny/ask permission rules still run first and win.
	 */
	override checkPermissions(
		_input: Record<string, unknown>,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (ctx.mode === "manual") {
			return undefined;
		}
		return {
			behavior: "allow",
			reason: "Client tool executed and confirmed by the connected IDE",
		};
	}

	override summarizeInput(input: Record<string, unknown>): string | undefined {
		const json = JSON.stringify(input);
		return json === "{}" ? undefined : json;
	}

	/** Advertise the IDE's JSON Schema verbatim instead of a Zod conversion. */
	override toJSONSchema(): OpenAITool {
		return {
			type: "function",
			function: {
				name: this.agentName,
				description: this.definition.description ?? "",
				parameters: this.definition.inputSchema ?? {
					type: "object",
					properties: {},
				},
			},
		};
	}

	override async execute(
		input: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<ToolResult<unknown>> {
		const payload = await this.bridge.invoke(this.name, input, ctx);
		if (payload.error || payload.success === false) {
			throw new Error(payload.error ?? "The client tool reported a failure.");
		}
		const texts: string[] = [];
		let image: { mimeType: string; dataBase64: string } | undefined;
		let extraImages = 0;
		for (const part of payload.content ?? []) {
			if (part.type === "text") {
				texts.push(part.text);
			} else if (part.type === "image") {
				if (image) {
					extraImages++;
				} else {
					image = part;
				}
			}
		}
		if (extraImages > 0) {
			texts.push(`(${extraImages} additional image(s) omitted)`);
		}
		const text = texts.join("\n");
		const data: Record<string, unknown> = {
			success: true,
			...(text ? { output: text } : {}),
			...(image
				? ImageContent.fromBase64(image.dataBase64, image.mimeType)
				: {}),
		};
		return ok(data, JSON.stringify(data), "Done");
	}
}
