import type {
	DynamicThinkingEvidence,
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
	ThinkingRequestKind,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type {
	AgentClient,
	RunMessageOptions,
} from "../../providers/AgentClient.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus } from "../bus/events.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import { AssistantAccumulator } from "./AssistantAccumulator.ts";
import { finalVerificationNotification } from "./notifications/FinalVerificationNotification.ts";
import { SystemNotificationRunner } from "./notifications/SystemNotificationRunner.ts";
import { todoReconciliationNotification } from "./notifications/TodoReconciliationNotification.ts";
import { ProviderStreamConsumer } from "./ProviderStreamConsumer.ts";
import { buildRunMessageRequest } from "./RunMessageRequestBuilder.ts";
import {
	isModelAvailabilityError,
	isThinkingCompatibilityError,
	modelKey,
} from "./RuntimeRecovery.ts";
import { hasStructuralDiagnosticText } from "./ThinkingEvidence.ts";
import { ToolRoundProcessor } from "./ToolRoundProcessor.ts";
import { Turn } from "./Turn.ts";

const SUBAGENT_PROVIDER_IDLE_TIMEOUT_MS = 30_000;
const SUBAGENT_PROVIDER_MAX_RETRIES = 1;

export type CapacityFallbackResolver = (
	current: ModelRef,
	attemptedModelKeys: ReadonlySet<string>,
	signal: AbortSignal,
) => Promise<ModelRef | null>;
export type ModelSucceededHandler = (model: ModelRef) => Promise<void> | void;
export type ThinkingDisabledHandler = (reason: string) => Promise<void> | void;

export interface AgentLoopDeps {
	client: AgentClient;
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	tools: OpenAITool[];
	systemPrompt: string;
	/** Recomputes the system prompt for injected notification requests; see SystemNotificationRunnerDeps. */
	refreshSystemPrompt?: () => string;
	assistantId?: string;
	model: { provider: string; model: string };
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	imageGeneration?: boolean;
	openRouterProvider?: string;
	generatedMediaDir?: string;
	thinking: ThinkingConfig | null | undefined;
	thinkingResolver?: RuntimeThinkingResolver;
	requestKind?: ThinkingRequestKind;
	finalVerificationNudge?: boolean;
	todoReconciliation?: boolean;
	turnId?: string;
	turnStartedAt?: number;
	turnAlreadyStarted?: boolean;
	maxToolRounds?: number;
	attachmentFilePaths?: string[];
	displayContent?: string;
	durableSession?: RunMessageOptions["durableSession"];
	resolveCapacityFallback?: CapacityFallbackResolver;
	onModelSucceeded?: ModelSucceededHandler;
	onThinkingDisabled?: ThinkingDisabledHandler;
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
		const finishTurn = async (status: TurnStatus): Promise<void> => {
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status,
				durationMs: turn.durationMs(),
			});
			// turn:end appends the checkpoint finalize marker synchronously. Do not
			// let the provider turn report completion until that marker and every
			// preceding mutation record have crossed the durability boundary.
			await ctx.checkpoints?.flush?.();
		};
		if (!this.deps.turnAlreadyStarted) {
			bus.emit({ type: "turn:start", turnId: turn.id });
		}

		const consumer = new ProviderStreamConsumer(bus, session, {
			imageGeneration: this.deps.imageGeneration,
			generatedMediaDir: this.deps.generatedMediaDir,
			...(this.deps.requestKind === "subagent"
				? {
						idleTimeoutMs: SUBAGENT_PROVIDER_IDLE_TIMEOUT_MS,
						maxRetries: SUBAGENT_PROVIDER_MAX_RETRIES,
					}
				: {}),
		});
		const activeModel = { ...this.deps.model };
		const attemptedModelKeys = new Set([modelKey(activeModel)]);
		let forceThinkingOff = false;
		let thinkingWarningEmitted = false;
		const disableThinking = async (reason: string) => {
			forceThinkingOff = true;
			if (thinkingWarningEmitted) return;
			thinkingWarningEmitted = true;
			bus.emit({
				type: "system:warning",
				message: `Thinking was disabled for this model so the turn could continue (${reason}).`,
			});
			await this.deps.onThinkingDisabled?.(reason);
		};
		const processor = new ToolRoundProcessor({
			client: this.deps.client,
			scheduler: this.deps.scheduler,
			session,
			bus,
			consumer,
			tools: this.deps.tools,
			resolveThinking: (evidence) =>
				forceThinkingOff ? null : this.resolveThinking(evidence),
			onThinkingDisabled: disableThinking,
			requestKind: this.deps.requestKind ?? "user",
			maxToolRounds: this.deps.maxToolRounds,
		});
		this.executedToolRounds = 0;

		const notificationDefinitions = [
			// Resolve the plan first: loop the todo reminder until the agent has
			// closed every todo, then let verification review the finished work and
			// produce the shown summary. Studio disables both hidden follow-up passes
			// so the answer the user watches stream is always the final answer.
			...(this.deps.todoReconciliation === false
				? []
				: [todoReconciliationNotification()]),
			finalVerificationNotification(this.deps.finalVerificationNudge ?? false),
		];
		const notifications = new SystemNotificationRunner(
			{
				client: this.deps.client,
				session,
				consumer,
				processor,
				tools: this.deps.tools,
				systemPrompt: this.deps.systemPrompt,
				refreshSystemPrompt: this.deps.refreshSystemPrompt,
				assistantId: this.deps.assistantId,
				model: activeModel,
				memory: this.deps.memory,
				memoryProfile: this.deps.memoryProfile,
				workspaceId: this.deps.workspaceId,
				requestKind: this.deps.requestKind ?? "user",
			},
			notificationDefinitions,
		);

		// Until the notification passes start, a final (no-tool-call) answer that
		// follows at least one tool round is only a preview of what a superseding
		// notification is about to re-answer - buffer it so it's discarded instead
		// of shown, and the notification pass's answer becomes the only summary.
		let notificationsStarted = false;
		const assistant = new AssistantAccumulator(turn.id, bus, session, {
			suppressFinalMessage: () =>
				!notificationsStarted && notifications.willSupersedeFinalAnswer(),
			suppressAllMessages: () =>
				notifications.activeNotificationHidesResponse(),
		});

		try {
			let initialThinking = this.resolveThinking({
				phase: "initial",
				requestKind: this.deps.requestKind ?? "user",
				hasDiagnosticText: hasStructuralDiagnosticText(content),
			});
			if (
				initialThinking === null &&
				this.deps.thinkingResolver?.intent !== undefined &&
				this.deps.thinkingResolver.intent !== null
			) {
				await disableThinking("the selected thinking controls are unsupported");
			}
			const messageOptions = {
				signal: ctx.signal,
				attachmentFilePaths: this.deps.attachmentFilePaths,
				displayContent: this.deps.displayContent,
				durableSession: this.deps.durableSession,
			};
			const buildMessageRequest = () =>
				buildRunMessageRequest(
					content,
					{ ...this.deps, model: activeModel },
					initialThinking,
				);
			const createMessageStream = (signal: AbortSignal) =>
				this.deps.client.runMessage(buildMessageRequest(), {
					...messageOptions,
					signal,
				});

			const early = processor.createEarlyRound(ctx, turn.id);
			const pending = await consumer.consumeWithRetry(
				createMessageStream,
				assistant,
				ctx.signal,
				early,
				() =>
					this.deps.client.preserveFailedMessage?.(
						buildMessageRequest(),
						messageOptions,
					) ?? Promise.resolve(null),
				async (error) => {
					if (isThinkingCompatibilityError(error)) {
						initialThinking = null;
						await disableThinking(errorMessage(error));
						return;
					}
					if (!isModelAvailabilityError(error)) return;
					const fallback = await this.deps.resolveCapacityFallback?.(
						activeModel,
						attemptedModelKeys,
						ctx.signal,
					);
					if (!fallback) return;
					activeModel.provider = fallback.provider;
					activeModel.model = fallback.model;
					attemptedModelKeys.add(modelKey(activeModel));
					// Thinking metadata belongs to the original model. The next turn can
					// resolve controls for the fallback normally after it becomes active.
					initialThinking = null;
					forceThinkingOff = true;
					bus.emit({
						type: "system:warning",
						message: `Model unavailable; retrying with ${activeModel.provider}/${activeModel.model}.`,
					});
				},
			);
			await processor.process(pending, turn.id, assistant, ctx, early);
			this.executedToolRounds = processor.executedRounds;
			notificationsStarted = true;
			await notifications.runPending(turn.id, assistant, ctx);
			this.executedToolRounds = processor.executedRounds;
			turn.status = "completed";
			await this.deps.onModelSucceeded?.(activeModel);
		} catch (err) {
			this.executedToolRounds = processor.executedRounds;
			if (err instanceof AbortError || ctx.signal.aborted) {
				turn.status = "cancelled";
				// Preserve whatever streamed before the interrupt: commit the
				// accumulated partial to the session so the next turn keeps it as
				// context (no-op if nothing streamed yet).
				assistant.finalize();
				bus.emit({ type: "turn:cancelled", turnId: turn.id });
				await finishTurn("cancelled");
				return "cancelled";
			}
			turn.status = "failed";
			bus.emit({
				type: "run:error",
				error: errorMessage(err),
			});
			await finishTurn("failed");
			return "failed";
		}

		await finishTurn(turn.status);
		return turn.status;
	}

	private resolveThinking(
		evidence: DynamicThinkingEvidence,
	): ThinkingConfig | null | undefined {
		if (this.deps.thinkingResolver) {
			return this.deps.thinkingResolver.resolve(evidence);
		}
		return this.deps.thinking;
	}
}
