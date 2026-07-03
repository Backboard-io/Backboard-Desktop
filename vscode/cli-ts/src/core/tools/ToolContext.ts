import type { AgentTraceStore } from "../agent/AgentTraceStore.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TodoItem } from "../bus/events.ts";
import type { LspService } from "../lsp/index.ts";
import type {
	PermissionGateDecision,
	PermissionGateRequest,
} from "./ToolPermissionGateTypes.ts";

export type AskUserFn = (
	question: string,
	options: string[],
) => Promise<string>;

export type RequestPermissionFn = (
	request: PermissionGateRequest,
) => Promise<PermissionGateDecision>;

export interface ToolTraceContext {
	forToolCall(toolCallId: string): ToolTraceContext;
	createAgentTrace(input: {
		mode: "worker" | "rlm";
		prompt: string;
	}): Promise<AgentTraceStore | null>;
}

/**
 * Everything a tool needs to do its job, and nothing more. Passed to every
 * `Tool.execute`. The `signal` aborts in-flight work on turn cancellation; the
 * `askUser` bridge round-trips an interactive question through the UI.
 */
export interface ToolContext {
	sessionId: string;
	turnId?: string;
	toolCallId?: string;
	cwd: string;
	bus: EventBus;
	signal: AbortSignal;
	askUser: AskUserFn;
	/**
	 * Optional approval gate for non-read-only tool calls. When present, the
	 * scheduler asks it before executing a gated call; absent means no gating
	 * (the interactive CLI's behavior).
	 */
	requestPermission?: RequestPermissionFn;
	getTodos?: () => readonly TodoItem[];
	agentDepth?: number;
	trace?: ToolTraceContext;
	/** Optional language-server service for post-edit diagnostics. */
	lsp?: LspService;
}
