import type {
	DynamicThinkingEvidence,
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
	ThinkingRequestKind,
} from "../../config/defaults.ts";
import { fingerprint } from "../../config/runtimeIdentity.ts";
import {
	createRuntimeThinkingResolver,
	type RuntimeThinkingResolver,
} from "../../config/thinkingRuntime.ts";
import type {
	AgentClient,
	RunMessageOptions,
} from "../../providers/AgentClient.ts";
import type { ModelSource } from "../../providers/backboard/types.ts";
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
import { ProviderStreamConsumer } from "./ProviderStreamConsumer.ts";
import { buildRunMessageRequest } from "./RunMessageRequestBuilder.ts";
import {
	isModelAvailabilityError,
	isThinkingCompatibilityError,
	modelKey,
} from "./RuntimeRecovery.ts";
import {
	hasStructuralDiagnosticText,
	isRoutineTask,
} from "./ThinkingEvidence.ts";
import { ToolRoundProcessor } from "./ToolRoundProcessor.ts";
import { Turn } from "./Turn.ts";
import {
	abortableDelay,
	isAccountBlockedError,
	isSignInRequiredError,
	TURN_FALLBACK_FROM_ATTEMPT,
	turnRetryDelayMs,
	turnRetryPrompt,
} from "./TurnRetry.ts";

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
	/**
	 * The billing route this loop was started on. It never changes for the
	 * life of the loop, even when a capacity fallback swaps the model, and it
	 * is stamped on every message, continuation, and injected notification.
	 */
	source?: ModelSource;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	imageGeneration?: boolean;
	imageModel?: { provider: string; name: string };
	videoGeneration?: boolean;
	videoModel?: { provider: string; name: string };
	openRouterProvider?: string;
	generatedMediaDir?: string;
	generatedVideoDir?: string;
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
	/**
	 * A model Backboard runs with no credit, for a turn the account is blocked
	 * from paying for (see TurnRetry.isAccountBlockedError).
	 */
	resolveFreeFallback?: CapacityFallbackResolver;
	onModelSucceeded?: ModelSucceededHandler;
	onThinkingDisabled?: ThinkingDisabledHandler;
	/**
	 * When set, a failed turn hands its error here instead of emitting
	 * `run:error`, so a caller that retries the turn decides whether the
	 * failure is terminal (the host marks a chat failed on any `run:error`).
	 */
	onRunError?: (error: string) => void;
	/** Attempts a failed turn gets before it is reported (default 1). */
	maxTurnAttempts?: number;
	/** Base retry backoff in ms; tests pass 0. */
	turnRetryBackoffMs?: number;
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
			videoGeneration: this.deps.videoGeneration,
			generatedMediaDir: this.deps.generatedMediaDir,
			generatedVideoDir: this.deps.generatedVideoDir,
			...(this.deps.requestKind === "subagent"
				? {
						idleTimeoutMs: SUBAGENT_PROVIDER_IDLE_TIMEOUT_MS,
						maxRetries: SUBAGENT_PROVIDER_MAX_RETRIES,
					}
				: {}),
		});
		const activeModel = { ...this.deps.model };
		let activeThinkingResolver = this.deps.thinkingResolver;
		const attemptedModelKeys = new Set([modelKey(activeModel)]);
		let forceThinkingOff = false;
		let thinkingWarningEmitted = false;
		const disableThinking = async (reason: string) => {
			forceThinkingOff = true;
			if (thinkingWarningEmitted) return;
			thinkingWarningEmitted = true;
			bus.emit({
				type: "system:warning",
				message: `Requested thinking controls could not be used (${reason}); the turn will use the provider fallback. Models may still reason internally.`,
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
			source: this.deps.source,
			resolveThinking: (evidence) =>
				forceThinkingOff
					? null
					: this.resolveThinking(evidence, activeThinkingResolver, activeModel),
			onThinkingDisabled: disableThinking,
			requestKind: this.deps.requestKind ?? "user",
			maxToolRounds: this.deps.maxToolRounds,
		});
		this.executedToolRounds = 0;

		// Plans are maintained alongside substantive work. No post-answer model
		// request is issued only to reconcile todo metadata.
		const notificationDefinitions = [
			finalVerificationNotification(this.deps.finalVerificationNudge ?? false),
		];
		const notifications = new SystemNotificationRunner(
			{
				client: this.deps.client,
				session,
				consumer,
				processor,
				resolveThinking: () =>
					forceThinkingOff
						? null
						: this.resolveThinking(
								{
									phase: "tool_outputs",
									requestKind: this.deps.requestKind ?? "user",
								},
								activeThinkingResolver,
								activeModel,
							),
				tools: this.deps.tools,
				systemPrompt: this.deps.systemPrompt,
				refreshSystemPrompt: this.deps.refreshSystemPrompt,
				assistantId: this.deps.assistantId,
				model: activeModel,
				source: this.deps.source,
				memory: this.deps.memory,
				memoryProfile: this.deps.memoryProfile,
				workspaceId: this.deps.workspaceId,
				requestKind: this.deps.requestKind ?? "user",
			},
			notificationDefinitions,
		);

		// Until the notification passes start, a final (no-tool-call) answer that
		// has evidence of unverified mutations is only a preview of what a superseding
		// notification is about to re-answer - buffer it so it's discarded instead
		// of shown, and the notification pass's answer becomes the only summary.
		let notificationsStarted = false;
		const assistant = new AssistantAccumulator(turn.id, bus, session, {
			suppressFinalMessage: () =>
				!notificationsStarted && notifications.willSupersedeFinalAnswer(),
			suppressAllMessages: () =>
				notifications.activeNotificationHidesResponse(),
		});

		const switchToFallbackModel = async (
			resolve = this.deps.resolveCapacityFallback,
		): Promise<boolean> => {
			const fallback = await resolve?.(
				activeModel,
				attemptedModelKeys,
				ctx.signal,
			).catch(() => null);
			if (!fallback) return false;
			activeModel.provider = fallback.provider;
			activeModel.model = fallback.model;
			attemptedModelKeys.add(modelKey(activeModel));
			// Re-resolve the user's intent against the fallback's capabilities.
			if (activeThinkingResolver) {
				const intent = activeThinkingResolver.intent;
				activeThinkingResolver = await createRuntimeThinkingResolver(
					{ model: activeModel, thinkingIntent: intent },
					this.deps.client,
				).catch(() => activeThinkingResolver);
			}
			forceThinkingOff = false;
			return true;
		};
		let switchedToFreeModel = false;

		// A failed turn is retried silently on the same thread (see TurnRetry.ts):
		// the model resumes with everything it already did, and later attempts
		// move to a fallback model. Only the last failure is reported.
		const maxAttempts = this.deps.maxTurnAttempts ?? 1;
		let attemptContent = content;
		for (let attempt = 1; ; attempt++) {
			try {
				if (ctx.signal.aborted) throw new AbortError();
				let initialThinking = this.resolveThinking(
					{
						phase: "initial",
						requestKind: this.deps.requestKind ?? "user",
						hasDiagnosticText: hasStructuralDiagnosticText(attemptContent),
						routineTask: isRoutineTask(attemptContent),
					},
					activeThinkingResolver,
					activeModel,
				);
				if (
					initialThinking === null &&
					this.deps.thinkingResolver?.intent !== undefined &&
					this.deps.thinkingResolver.intent !== null
				) {
					await disableThinking(
						"the selected thinking controls are unsupported",
					);
				}
				const messageOptions = {
					signal: ctx.signal,
					attachmentFilePaths: this.deps.attachmentFilePaths,
					displayContent: this.deps.displayContent,
					durableSession: this.deps.durableSession,
				};
				const buildMessageRequest = () =>
					buildRunMessageRequest(
						attemptContent,
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
						// Re-resolve the user's intent against the fallback's capabilities.
						if (activeThinkingResolver) {
							activeThinkingResolver = await createRuntimeThinkingResolver(
								{
									model: activeModel,
									thinkingIntent: activeThinkingResolver.intent,
								},
								this.deps.client,
							);
							initialThinking = this.resolveThinking(
								{
									phase: "initial",
									requestKind: this.deps.requestKind ?? "user",
									routineTask: isRoutineTask(attemptContent),
									hasDiagnosticText:
										hasStructuralDiagnosticText(attemptContent),
								},
								activeThinkingResolver,
								activeModel,
							);
						} else
							initialThinking = this.deps.thinking === null ? null : undefined;
						forceThinkingOff = false;
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
				break;
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
				const accountBlocked = isAccountBlockedError(err);
				// Out of credit: no paid model will run, but Backboard's $0 models
				// still do. Move the turn to one once instead of failing it.
				if (
					accountBlocked &&
					!switchedToFreeModel &&
					this.deps.resolveFreeFallback
				) {
					switchedToFreeModel = true;
					const blockedModel = `${activeModel.provider}/${activeModel.model}`;
					if (await switchToFallbackModel(this.deps.resolveFreeFallback)) {
						assistant.finalize();
						bus.emit({
							type: "system:warning",
							message: isSignInRequiredError(err)
								? `This reply uses ${activeModel.model}, a free model. Sign in to use ${blockedModel}.`
								: `You're out of credits, so this reply uses ${activeModel.model}, a free model. Add credits on the Billing page to use ${blockedModel} again.`,
						});
						continue;
					}
				}
				if (attempt < maxAttempts && !accountBlocked) {
					// Keep any partial answer as context for the continuation.
					assistant.finalize();
					attemptContent = turnRetryPrompt(content, errorMessage(err));
					if (attempt + 1 >= TURN_FALLBACK_FROM_ATTEMPT) {
						await switchToFallbackModel();
					}
					await abortableDelay(
						turnRetryDelayMs(attempt, this.deps.turnRetryBackoffMs),
						ctx.signal,
					);
					continue;
				}
				turn.status = "failed";
				if (this.deps.onRunError) this.deps.onRunError(errorMessage(err));
				else
					bus.emit({
						type: "run:error",
						error: errorMessage(err),
						...(accountBlocked ? { actionable: true } : {}),
					});
				await finishTurn("failed");
				return "failed";
			}
		}

		await finishTurn(turn.status);
		return turn.status;
	}

	private resolveThinking(
		evidence: DynamicThinkingEvidence,
		resolver = this.deps.thinkingResolver,
		model = this.deps.model,
	): ThinkingConfig | null | undefined {
		const resolved = resolver ? resolver.resolve(evidence) : this.deps.thinking;
		const intent = resolver?.intent;
		this.deps.bus.emit({
			type: "thinking:resolved",
			phase: evidence.phase,
			...model,
			intent: intent ?? (intent === null ? "off" : "unspecified"),
			resolved: resolved === undefined ? "provider-default" : resolved,
			reason:
				intent?.kind !== "dynamic"
					? "fixed-or-provider-default"
					: evidence.toolRound?.hadSemanticFailure
						? "failed-validation"
						: evidence.hasDiagnosticText
							? "user-diagnostics"
							: evidence.phase === "tool_outputs"
								? "routine-continuation"
								: evidence.routineTask
									? "routine-task"
									: "task-default",
			...(evidence.phase === "initial"
				? {
						promptHash: fingerprint(this.deps.systemPrompt),
						schemaHash: fingerprint(this.deps.tools),
					}
				: {}),
		});
		return resolved;
	}
}
