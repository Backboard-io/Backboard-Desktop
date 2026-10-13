import type {
	DynamicThinkingEvidence,
	ThinkingConfig,
} from "../../config/defaults.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import type {
	ModelSource,
	SubmitToolOutputsRequest,
} from "../../providers/backboard/types.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import { type ToolResultRecord, toolMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type {
	ToolCallRound,
	ToolOutput,
	ToolScheduler,
} from "../tools/ToolScheduler.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";
import { CompletionEvidenceTracker } from "./CompletionEvidence.ts";
import type {
	PendingAction,
	ProviderStreamConsumer,
} from "./ProviderStreamConsumer.ts";
import { preserveProviderContext } from "./ProviderStreamConsumer.ts";
import { isThinkingCompatibilityError } from "./RuntimeRecovery.ts";
import { estimateTokens } from "../context/tokens.ts";
import { summarizeToolRound, toolRoundFailed } from "./ToolRoundEvidence.ts";
import { ContextCompactionNeeded } from "./TurnRetry.ts";

export interface ToolRoundProcessorDeps {
	client: AgentClient;
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	consumer: ProviderStreamConsumer;
	tools: SubmitToolOutputsRequest["tools"];
	/** The turn's captured billing route, stamped on every continuation. */
	source?: ModelSource;
	resolveThinking: (
		evidence: DynamicThinkingEvidence,
	) => ThinkingConfig | null | undefined;
	requestKind: DynamicThinkingEvidence["requestKind"];
	onThinkingDisabled?: (reason: string) => Promise<void> | void;
	maxToolRounds?: number;
	/** See AgentLoopDeps.needsCompaction. */
	needsCompaction?: (pendingTokens: number) => boolean;
}

export class ToolRoundProcessor {
	private readonly answered = new Map<string, string>();
	private readonly completion = new CompletionEvidenceTracker();
	private readonly unavailableTools = new Set<string>();

	get completionEvidence() {
		return this.completion.snapshot;
	}
	private consecutiveFailureCount = 0;
	private maxUsed = false;
	private rounds = 0;

	constructor(private readonly deps: ToolRoundProcessorDeps) {}

	get executedRounds(): number {
		return this.rounds;
	}

	get executedToolCalls(): number {
		return this.answered.size;
	}

	/**
	 * A round that ignores calls already answered in a previous round (the
	 * round is its own EarlyToolSink). Create one before consuming a provider
	 * stream and hand it to the consumer so streamed calls render/execute
	 * early; then pass it to process() so finalize reuses the early results.
	 */
	createEarlyRound(ctx: ToolContext, turnId: string): ToolCallRound {
		return this.deps.scheduler.createRound(
			{ ...ctx, turnId },
			{ skip: (id) => this.answered.has(id) },
		);
	}

	async process(
		pending: PendingAction | null,
		turnId: string,
		assistant: AssistantAccumulator,
		ctx: ToolContext,
		initialRound: ToolCallRound,
		maxAdditionalRounds?: number,
	): Promise<void> {
		let round = initialRound;
		const startingRounds = this.rounds;
		try {
			while (pending) {
				if (
					maxAdditionalRounds !== undefined &&
					this.rounds - startingRounds >= maxAdditionalRounds
				) {
					throw new Error(
						"Verification tool-round budget exhausted; remaining work needs a visible follow-up.",
					);
				}
				for (const call of pending.calls) {
					const previous = this.answered.get(call.id);
					if (
						previous !== undefined &&
						previous !== this.deps.scheduler.callIdentity(call)
					) {
						throw new Error(
							`Tool protocol error: already answered call ${call.id} changed identity.`,
						);
					}
				}
				const newCalls = pending.calls.filter(
					(call) => !this.answered.has(call.id),
				);
				if (newCalls.length === 0) return;
				for (const call of newCalls)
					this.answered.set(call.id, this.deps.scheduler.callIdentity(call));

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
				let outputs: ToolOutput[];
				try {
					outputs = await round.finalize(newCalls);
				} catch (error) {
					if (!(error instanceof AbortError) && !ctx.signal.aborted)
						throw error;
					const completed = new Map(
						round
							.completedToolOutputs()
							.map((output) => [output.tool_call_id, output]),
					);
					outputs = newCalls.map(
						(call) =>
							completed.get(call.id) ?? {
								tool_call_id: call.id,
								output:
									"Error: Tool execution was interrupted before results were submitted.",
								metadata: {
									name: call.name,
									readOnly: false,
									error: true,
									failureCategory: "cancelled",
									cancelled: true,
									retryable: false,
								},
							},
					);
					this.recordToolMessage(newCalls, outputs);
					const failedRequest: SubmitToolOutputsRequest = {
						thread_id: this.deps.session.threadId ?? "",
						...(pending.runId ? { run_id: pending.runId } : {}),
						tool_outputs: outputs.map(toBackboardToolOutput),
						tools: this.deps.tools,
						...this.routeFields(),
					};
					await preserveProviderContext(
						this.deps.bus,
						() =>
							this.deps.client.preserveFailedToolOutputs?.(failedRequest) ??
							Promise.resolve(null),
						"interrupted tool context",
					);
					throw error;
				}
				this.recordToolMessage(newCalls, outputs);
				// The outputs are recorded locally, so a compression now keeps
				// them; submitting them first would push the window further past
				// the line it already crossed.
				if (
					this.deps.needsCompaction?.(
						outputs.reduce(
							(sum, output) => sum + estimateTokens(output.output),
							0,
						),
					)
				) {
					throw new ContextCompactionNeeded();
				}
				this.completion.observe(outputs);
				for (const output of outputs) {
					if (output.metadata?.failureCategory === "unavailable") {
						const name = output.metadata.name.toLowerCase();
						this.unavailableTools.add(name);
						if (name === "grep" || name === "glob") {
							this.unavailableTools.add("grep");
							this.unavailableTools.add("glob");
						}
					}
				}

				let continuationThinking = this.resolveContinuationThinking(outputs);
				const runId = pending.runId;
				const buildRequest = (): SubmitToolOutputsRequest => ({
					thread_id: this.deps.session.threadId ?? "",
					...(runId ? { run_id: runId } : {}),
					...this.routeFields(),
					tool_outputs: outputs.map(toBackboardToolOutput),
					tools: this.deps.tools?.filter(
						(tool) =>
							!this.unavailableTools.has(tool.function.name.toLowerCase()),
					),
					...(continuationThinking === undefined
						? {}
						: { thinking: continuationThinking }),
				});
				round = this.createEarlyRound(ctx, turnId);
				// The initial send path already emits this phase, but continuations
				// previously went visually blank while the model generated a large
				// tool payload. Restore an ephemeral heartbeat immediately after the
				// prior tools finish; real reasoning, text, or a tool row replaces it.
				this.deps.bus.emit({
					type: "turn:status",
					turnId,
					phase: "generating",
				});
				pending = await this.deps.consumer.consumeWithRetry(
					(signal) =>
						this.deps.client.runToolOutputs(buildRequest(), {
							signal,
						}),
					assistant,
					ctx.signal,
					round,
					() =>
						this.deps.client.preserveFailedToolOutputs?.(buildRequest()) ??
						Promise.resolve(null),
					async (error) => {
						if (
							isThinkingCompatibilityError(error) &&
							continuationThinking !== undefined &&
							continuationThinking !== null
						) {
							continuationThinking = null;
							await this.deps.onThinkingDisabled?.(String(error));
						}
					},
				);
			}
		} finally {
			// Whatever ends the loop - a stream that completed without
			// requires_action, dedup short-circuit, error, or cancellation -
			// the current round was never finalized: abort its early runs and
			// retract its announced rows. No-op after a normal finalize.
			round.reset();
		}
	}

	/** The captured route, present only when the turn started with one. */
	private routeFields(): Pick<SubmitToolOutputsRequest, "source"> {
		return this.deps.source === undefined ? {} : { source: this.deps.source };
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
		const continuationThinking = this.deps.resolveThinking({
			phase: "tool_outputs",
			requestKind: this.deps.requestKind,
			toolRound: roundEvidence,
		});
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
				isError: output?.metadata?.error === true,
				execution: output?.metadata,
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
