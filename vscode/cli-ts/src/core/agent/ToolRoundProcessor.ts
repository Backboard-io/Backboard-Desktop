import type {
	DynamicThinkingEvidence,
	ThinkingConfig,
} from "../../config/defaults.ts";
import { DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD } from "../../config/thinking.constants.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import type { SubmitToolOutputsRequest } from "../../providers/backboard/types.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import { type ToolResultRecord, toolMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolOutput, ToolScheduler } from "../tools/ToolScheduler.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";
import { ExecutionPacing } from "./ExecutionPacing.ts";
import type {
	PendingAction,
	ProviderStreamConsumer,
} from "./ProviderStreamConsumer.ts";
import { summarizeToolRound, toolRoundFailed } from "./ToolRoundEvidence.ts";

export interface ToolRoundProcessorDeps {
	client: BackboardClient;
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	consumer: ProviderStreamConsumer;
	tools: SubmitToolOutputsRequest["tools"];
	resolveThinking: (
		evidence: DynamicThinkingEvidence,
	) => ThinkingConfig | null | undefined;
	requestKind: DynamicThinkingEvidence["requestKind"];
	maxToolRounds?: number;
}

export class ToolRoundProcessor {
	private readonly answered = new Set<string>();
	private consecutiveFailureCount = 0;
	private maxUsed = false;
	private rounds = 0;
	private readonly executionPacing = new ExecutionPacing();

	constructor(private readonly deps: ToolRoundProcessorDeps) {}

	get executedRounds(): number {
		return this.rounds;
	}

	get executedToolCalls(): number {
		return this.answered.size;
	}

	async process(
		pending: PendingAction | null,
		turnId: string,
		assistant: AssistantAccumulator,
		ctx: ToolContext,
	): Promise<void> {
		while (pending) {
			const newCalls = pending.calls.filter(
				(call) => !this.answered.has(call.id),
			);
			if (newCalls.length === 0) return;
			for (const call of newCalls) this.answered.add(call.id);

			if (
				this.deps.maxToolRounds !== undefined &&
				this.rounds >= this.deps.maxToolRounds
			) {
				throw new Error(
					`Tool round limit exceeded (${this.deps.maxToolRounds})`,
				);
			}
			this.rounds++;

			this.deps.bus.emit({
				type: "tool:requested",
				turnId,
				calls: newCalls,
			});
			const outputs = await this.deps.scheduler.run(newCalls, {
				...ctx,
				turnId,
			});
			this.recordToolMessage(newCalls, outputs);
			const submittedOutputs =
				this.executionPacing.prepareForSubmission(outputs);

			const continuationThinking = this.resolveContinuationThinking(outputs);
			const request: SubmitToolOutputsRequest = {
				thread_id: this.deps.session.threadId ?? "",
				...(pending.runId ? { run_id: pending.runId } : {}),
				tool_outputs: submittedOutputs.map(toBackboardToolOutput),
				tools: this.deps.tools,
				...(continuationThinking === undefined
					? {}
					: { thinking: continuationThinking }),
			};
			pending = await this.deps.consumer.consumeWithRetry(
				() =>
					this.deps.client.runToolOutputs(request, {
						signal: ctx.signal,
					}),
				assistant,
				ctx.signal,
			);
		}
	}

	private resolveContinuationThinking(
		outputs: ToolOutput[],
	): ThinkingConfig | null | undefined {
		const roundFailure = toolRoundFailed(outputs);
		if (roundFailure) {
			this.consecutiveFailureCount++;
		} else {
			this.consecutiveFailureCount = 0;
			this.maxUsed = false;
		}
		const roundEvidence = {
			index: this.rounds,
			...summarizeToolRound(outputs),
			consecutiveFailureCount: this.consecutiveFailureCount,
			maxUsed: this.maxUsed,
		};
		const shouldMarkMaxUsed =
			roundFailure &&
			this.consecutiveFailureCount >= DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD &&
			!this.maxUsed;
		const continuationThinking = this.deps.resolveThinking({
			phase: "tool_outputs",
			requestKind: this.deps.requestKind,
			toolRound: roundEvidence,
		});
		if (shouldMarkMaxUsed) this.maxUsed = true;
		return continuationThinking;
	}

	private recordToolMessage(calls: ToolCallRef[], outputs: ToolOutput[]): void {
		const byId = new Map(
			outputs.map((output) => [output.tool_call_id, output]),
		);
		const results: ToolResultRecord[] = calls.map((call) => {
			const output = byId.get(call.id);
			return {
				toolCallId: call.id,
				name: call.name,
				output: output?.output ?? "",
				isError:
					output?.metadata?.error === true ||
					(output?.output ?? "").startsWith("Error:"),
			};
		});
		this.deps.session.addMessage(toolMessage(results));
	}
}

function toBackboardToolOutput(output: ToolOutput): {
	tool_call_id: string;
	output: string;
} {
	return { tool_call_id: output.tool_call_id, output: output.output };
}
