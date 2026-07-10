import type {
	DynamicThinkingEvidence,
	MemoryMode,
	MemoryProfile,
	ThinkingConfig,
	ThinkingRequestKind,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import { invalidateAssistantCache } from "../../providers/backboard/assistants.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import { BackboardError } from "../../providers/backboard/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus } from "../bus/events.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import { AssistantAccumulator } from "./AssistantAccumulator.ts";
import {
	FinalVerificationRunner,
	willRunFinalVerification,
} from "./FinalVerificationRunner.ts";
import { ProviderStreamConsumer } from "./ProviderStreamConsumer.ts";
import { buildRunMessageRequest } from "./RunMessageRequestBuilder.ts";
import { hasStructuralDiagnosticText } from "./ThinkingEvidence.ts";
import { ToolRoundProcessor } from "./ToolRoundProcessor.ts";
import { Turn } from "./Turn.ts";

export interface AgentLoopDeps {
	client: BackboardClient;
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	tools: OpenAITool[];
	systemPrompt: string;
	assistantId?: string;
	model: { provider: string; model: string };
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	thinking: ThinkingConfig | null | undefined;
	thinkingResolver?: RuntimeThinkingResolver;
	requestKind?: ThinkingRequestKind;
	finalVerificationNudge?: boolean;
	turnId?: string;
	turnStartedAt?: number;
	turnAlreadyStarted?: boolean;
	maxToolRounds?: number;
}

/**
 * The provider-agnostic turn engine. It drives one user turn to completion:
 * send the message, process the provider event stream, and while the run
 * requires action, execute tools and submit their outputs - looping until the
 * run completes or fails. Cancellation propagates as AbortError; no partial
 * tool outputs are submitted on cancel.
 */
export class AgentLoop {
	private executedToolRounds = 0;

	constructor(private readonly deps: AgentLoopDeps) {}

	/** Tool-call rounds executed in the last run. */
	get toolRounds(): number {
		return this.executedToolRounds;
	}

	async run(content: string, ctx: ToolContext): Promise<TurnStatus> {
		const { bus, session } = this.deps;
		const turn = new Turn(this.deps.turnId, this.deps.turnStartedAt);
		if (!this.deps.turnAlreadyStarted) {
			bus.emit({ type: "turn:start", turnId: turn.id });
		}

		const consumer = new ProviderStreamConsumer(bus, session);
		const processor = new ToolRoundProcessor({
			client: this.deps.client,
			scheduler: this.deps.scheduler,
			session,
			bus,
			consumer,
			tools: this.deps.tools,
			resolveThinking: (evidence) => this.resolveThinking(evidence),
			requestKind: this.deps.requestKind ?? "user",
			maxToolRounds: this.deps.maxToolRounds,
		});
		this.executedToolRounds = 0;

		// Until the verification pass starts, a final (no-tool-call) answer that
		// follows at least one tool round is only a preview of what the nudge is
		// about to re-answer - buffer it so it's discarded instead of shown, and
		// the verification pass's answer becomes the only summary shown.
		let verificationStarted = false;
		const assistant = new AssistantAccumulator(turn.id, bus, session, {
			suppressFinalMessage: () =>
				!verificationStarted &&
				willRunFinalVerification({
					finalVerificationNudge: this.deps.finalVerificationNudge,
					requestKind: this.deps.requestKind ?? "user",
					executedRounds: processor.executedRounds,
					executedToolCalls: processor.executedToolCalls,
				}),
		});

		try {
			const initialThinking = this.resolveThinking({
				phase: "initial",
				requestKind: this.deps.requestKind ?? "user",
				hasDiagnosticText: hasStructuralDiagnosticText(content),
			});
			const createMessageStream = () =>
				this.deps.client.runMessage(
					buildRunMessageRequest(content, this.deps, initialThinking),
					{ signal: ctx.signal },
				);

			const pending = await consumer.consumeWithRetry(
				createMessageStream,
				assistant,
				ctx.signal,
			);
			await processor.process(pending, turn.id, assistant, ctx);
			this.executedToolRounds = processor.executedRounds;
			verificationStarted = true;
			await new FinalVerificationRunner({
				client: this.deps.client,
				session,
				bus,
				consumer,
				processor,
				tools: this.deps.tools,
				systemPrompt: this.deps.systemPrompt,
				assistantId: this.deps.assistantId,
				model: this.deps.model,
				memory: this.deps.memory,
				memoryProfile: this.deps.memoryProfile,
				finalVerificationNudge: this.deps.finalVerificationNudge,
				requestKind: this.deps.requestKind ?? "user",
			}).runIfNeeded(turn.id, assistant, ctx);
			this.executedToolRounds = processor.executedRounds;
			turn.status = "completed";
		} catch (err) {
			this.executedToolRounds = processor.executedRounds;
			if (err instanceof AbortError || ctx.signal.aborted) {
				turn.status = "cancelled";
				// Preserve whatever streamed before the interrupt: commit the
				// accumulated partial to the session so the next turn keeps it as
				// context (no-op if nothing streamed yet).
				assistant.finalize();
				bus.emit({ type: "turn:cancelled", turnId: turn.id });
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "cancelled",
					durationMs: turn.durationMs(),
				});
				return "cancelled";
			}
			turn.status = "failed";
			// A 404 on the turn means the assistant no longer exists server-side
			// (deleted, or cached from another account). Drop the stale id so the
			// next message provisions a fresh assistant instead of failing forever.
			let errorMessage = err instanceof Error ? err.message : String(err);
			if (isStaleAssistantError(err)) {
				if (this.deps.assistantId) {
					invalidateAssistantCache(this.deps.assistantId);
				}
				session.assistantId = null;
				errorMessage =
					"Backboard assistant was not found (it may belong to a previous sign-in). Cleared the stale assistant — please send your message again.";
			}
			bus.emit({
				type: "run:error",
				error: errorMessage,
			});
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status: "failed",
				durationMs: turn.durationMs(),
			});
			return "failed";
		}

		bus.emit({
			type: "turn:end",
			turnId: turn.id,
			status: turn.status,
			durationMs: turn.durationMs(),
		});
		return turn.status;
	}

	private resolveThinking(
		evidence: DynamicThinkingEvidence,
	): ThinkingConfig | null | undefined {
		if (this.deps.thinkingResolver) {
			return this.deps.thinkingResolver.resolve(evidence);
		}
		return evidence.phase === "initial" ? this.deps.thinking : undefined;
	}
}

/** True when the backend rejected the turn because the assistant id is gone. */
function isStaleAssistantError(err: unknown): boolean {
	if (!(err instanceof BackboardError) || err.status !== 404) {
		return false;
	}
	const detail =
		err.body && typeof err.body === "object"
			? (err.body as { detail?: unknown }).detail
			: undefined;
	return typeof detail === "string" && /assistant not found/i.test(detail);
}
