import type {
	MemoryMode,
	MemoryProfile,
	ThinkingRequestKind,
} from "../../config/defaults.ts";
import { FINAL_VERIFICATION_NUDGE } from "../../prompts/finalVerification.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";
import type { ProviderStreamConsumer } from "./ProviderStreamConsumer.ts";
import { buildRunMessageRequest } from "./RunMessageRequestBuilder.ts";
import type { ToolRoundProcessor } from "./ToolRoundProcessor.ts";

/**
 * Shared by FinalVerificationRunner.shouldRun and AgentLoop's suppression
 * predicate so the "will the nudge fire" decision can never diverge between
 * the two call sites.
 */
export const FINAL_VERIFICATION_MIN_TOOL_CALLS = 17; // min number of indiivdual tool calls before verification nudge fires.

export function willRunFinalVerification(params: {
	finalVerificationNudge?: boolean;
	requestKind: ThinkingRequestKind;
	executedRounds: number;
	executedToolCalls: number;
}): boolean {
	return (
		(params.finalVerificationNudge ?? false) &&
		params.requestKind === "user" &&
		params.executedRounds > 0 &&
		params.executedToolCalls >= FINAL_VERIFICATION_MIN_TOOL_CALLS
	);
}

export interface FinalVerificationRunnerDeps {
	client: BackboardClient;
	session: Session;
	bus: EventBus;
	consumer: ProviderStreamConsumer;
	processor: ToolRoundProcessor;
	tools: OpenAITool[];
	systemPrompt: string;
	assistantId?: string;
	model: { provider: string; model: string };
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	finalVerificationNudge?: boolean;
	requestKind: ThinkingRequestKind;
}

export class FinalVerificationRunner {
	constructor(private readonly deps: FinalVerificationRunnerDeps) {}

	async runIfNeeded(
		turnId: string,
		assistant: AssistantAccumulator,
		ctx: ToolContext,
	): Promise<void> {
		if (!this.shouldRun()) return;
		const pending = await this.deps.consumer.consumeWithRetry(
			() =>
				this.deps.client.runMessage(
					buildRunMessageRequest(FINAL_VERIFICATION_NUDGE, this.deps),
					{ signal: ctx.signal },
				),
			assistant,
			ctx.signal,
		);
		await this.deps.processor.process(pending, turnId, assistant, ctx);
	}

	private shouldRun(): boolean {
		return willRunFinalVerification({
			finalVerificationNudge: this.deps.finalVerificationNudge,
			requestKind: this.deps.requestKind,
			executedRounds: this.deps.processor.executedRounds,
			executedToolCalls: this.deps.processor.executedToolCalls,
		});
	}
}
