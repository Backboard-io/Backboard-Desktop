import { shortId } from "../../utils/id.ts";
import { EventBus } from "../bus/EventBus.ts";
import { ClientEventLog } from "../session/ClientEventLog.ts";
import { Session } from "../session/Session.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { ToolRegistry } from "../tools/ToolRegistry.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import { MAX_SUBAGENT_TOOL_ROUNDS } from "./SubAgentConstants.ts";
import type {
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
} from "./SubAgentTypes.ts";

export type {
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
	SubAgentToolFactory,
} from "./SubAgentTypes.ts";

/**
 * Drives one isolated sub-agent to completion and returns only its distilled
 * report. The sub-agent gets its own Session, EventBus, tool registry, and
 * Backboard thread, so its intermediate tool churn never enters the parent's
 * context. This context isolation is the core property that lets a long coding
 * session delegate work without suffering context rot.
 */
export class SubAgentRunner {
	constructor(private readonly deps: SubAgentRunnerDeps) {}

	async run(params: SubAgentRunParams): Promise<SubAgentResult> {
		const bus = new EventBus();
		const session = new Session(shortId("subagent"));
		const detachSessionProjection = session.attach(bus);
		const childLog = params.trace
			? new ClientEventLog(params.trace.sessionId, params.trace.clientLogPath)
			: null;
		childLog?.attach(bus);
		if (params.trace) {
			bus.emit({
				type: "session:created",
				sessionId: session.sessionId,
				threadId: session.threadId,
			});
		}
		const detachParentProgress = this.attachParentProgressRelay(params, bus);

		const reports: string[] = [];
		bus.on("assistant:message", (event) => {
			const text = event.text.trim();
			if (text) reports.push(text);
		});

		const tools = this.deps.toolFactory({
			depth: params.depth,
		});
		const registry = new ToolRegistry(tools);
		const toolSchemas = registry.toJSONSchemas();
		const loopFactory = new AgentLoopFactory({
			client: this.deps.client,
			hookController: this.deps.hookController,
		});
		const scheduler = loopFactory.createScheduler({
			registry,
			bus,
			isToolEnabled: this.deps.isToolEnabled,
		});

		const model = this.deps.getModel();
		const thinkingResolver = this.deps.getThinkingResolver
			? await this.deps.getThinkingResolver()
			: undefined;
		const thinking = thinkingResolver
			? undefined
			: await this.deps.getThinking();

		const ctx: ToolContext = {
			sessionId: session.sessionId,
			cwd: params.parentCwd,
			bus,
			signal: params.parentSignal,
			// A sub-agent can never prompt the human, so AskUser is unavailable.
			askUser: async () => {
				throw new Error("A sub-agent cannot ask the user a question.");
			},
			getTodos: () => session.todos,
			agentDepth: params.depth,
			trace: params.trace?.context,
			lsp: this.deps.lsp,
		};

		const loop = loopFactory.createLoop({
			scheduler,
			session,
			bus,
			tools: toolSchemas,
			systemPrompt: this.deps.systemPrompt,
			model,
			memory: this.deps.memory,
			memoryProfile: this.deps.memoryProfile,
			thinking,
			thinkingResolver,
			requestKind: "subagent",
			maxToolRounds: MAX_SUBAGENT_TOOL_ROUNDS,
		});

		try {
			const status = await loop.run(params.prompt.trim(), ctx);

			return {
				report: reports.at(-1) ?? "(the sub-agent produced no output)",
				status,
				usage: session.usage,
				toolRounds: loop.toolRounds,
			};
		} finally {
			detachParentProgress();
			detachSessionProjection();
			await childLog?.flush();
		}
	}

	private attachParentProgressRelay(
		params: SubAgentRunParams,
		bus: EventBus,
	): () => void {
		if (!params.parentBus || !params.parentToolCallId) return () => {};
		const detachStart = bus.on("tool:start", (event) => {
			params.parentBus?.emit({
				type: "agent:child_tool_start",
				agentToolCallId: params.parentToolCallId ?? "",
				call: {
					id: event.toolCallId,
					name: event.name,
					inputSummary: event.inputSummary,
					status: "running",
				},
			});
		});
		const detachResult = bus.on("tool:result", (event) => {
			params.parentBus?.emit({
				type: "agent:child_tool_result",
				agentToolCallId: params.parentToolCallId ?? "",
				childToolCallId: event.toolCallId,
				status: "done",
			});
		});
		const detachError = bus.on("tool:error", (event) => {
			params.parentBus?.emit({
				type: "agent:child_tool_result",
				agentToolCallId: params.parentToolCallId ?? "",
				childToolCallId: event.toolCallId,
				status: "error",
			});
		});
		return () => {
			detachStart();
			detachResult();
			detachError();
		};
	}
}
