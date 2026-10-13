import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config/Config.ts";
import type { ModelRef } from "../../config/defaults.ts";
import { qSessionDir } from "../../config/paths.ts";
import { fingerprint, PROMPT_VERSION } from "../../config/runtimeIdentity.ts";
import { createRuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import { toPromptProfileId } from "../../prompts/profiles/ids.ts";
import {
	buildGenerativeMediaPrompt,
	CANVAS_PROJECT_FILE,
	type CanvasProjectSettings,
	parseCanvasProjectSettings,
} from "../../prompts/system/generativeMedia.ts";
import { getSystemPrompt } from "../../prompts/system/index.tsx";
import { TODO_NOT_CALLED_REMINDER } from "../../prompts/todoReminders.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { BackboardError } from "../../providers/backboard/errors.ts";
import { normalizeSelectableModels } from "../../providers/backboard/modelCatalog.ts";
import type {
	ModelRoute,
	ModelSource,
} from "../../providers/backboard/types.ts";
import { errorMessage } from "../../utils/errors.ts";
import { shortId } from "../../utils/id.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type {
	AskUserQuestionSpec,
	PerformanceTimingPhase,
	TurnStatus,
} from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import {
	AUTO_COMPACT_THRESHOLD_PERCENT,
	buildContextReport,
	CompactionError,
	type CompactionResult,
	Compactor,
	type ContextReport,
	shouldAutoCompact,
} from "../context/index.ts";
import { TERMINAL_HOOK_TIMEOUT_MS } from "../hooks/constants.ts";
import {
	type HookController,
	joinHookContext,
	type UserPromptHookResult,
} from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import {
	nextPermissionMode,
	type PermissionMode,
} from "../permissions/PermissionMode.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type { Message } from "../session/Message.ts";
import { userMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";
import type { SkillController } from "../skills/SkillController.ts";
import { ClientProxyTool } from "../tools/ClientToolBridge.ts";
import { canonicalToolName } from "../tools/names.ts";
import type { OpenAITool } from "../tools/schema.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import type {
	CancelOptions,
	QueuedSubmit,
	SubmitOptions,
} from "./AgentControllerTypes.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import type { AgentTaskManager } from "./AgentTaskManager.ts";
import { AgentTraceContext } from "./AgentTraceStore.ts";
import { AssistantSessionBinding } from "./AssistantSessionBinding.ts";
import {
	capacityFallbackCandidates,
	freeFallbackCandidates,
	modelKey,
} from "./RuntimeRecovery.ts";
import { Turn } from "./Turn.ts";
import { isAccountBlockedError, TURN_MAX_ATTEMPTS } from "./TurnRetry.ts";

export interface AgentControllerDeps {
	/** Base backoff between silent retries of a failed turn; tests pass 0. */
	turnRetryBackoffMs?: number;
	config: Config;
	bus: EventBus;
	session: Session;
	registry: ToolRegistry;
	client: AgentClient;
	skillController: SkillController;
	hookController?: HookController;
	assistantBinding?: AssistantSessionBinding;
	syncDynamicTools?: (signal: AbortSignal) => Promise<void>;
	/** Override hidden post-answer verification passes for this host. */
	finalVerificationNudge?: boolean;
	/** Override hidden todo-reconciliation passes for this host. */
	todoReconciliation?: boolean;
	/** Compress between turns for hosts without the interactive CLI UI. */
	autoCompact?: boolean;
	startupEnvironmentPrompt?: string;
	lsp?: LspService;
	checkpoints?: CheckpointRecorder;
	getDurableSession?: () => {
		sessionId: string;
		sessionRoot: string;
		replacesThreadId?: string;
	};
	onThreadReplaced?: (threadId: string | null) => void;
	permissions: PermissionContext;
	/**
	 * Absolute path to this run's client transcript. Named in the handoff so a
	 * compressed agent can read back anything the summary left out.
	 */
	transcriptPath?: string;
	getTranscriptPath?: () => string;
	agentTasks?: Pick<AgentTaskManager, "cancelAll" | "waitForIdle">;
}

/**
 * Public facade the UI talks to. Owns per-turn cancellation, the AskUser bridge
 * between tools and the UI, and the wiring of a fresh AgentLoop per submission.
 */
export class AgentController {
	private pendingAutoResume: string | undefined;
	private cancellationVersion = 0;
	private abortController: AbortController | null = null;
	private readonly pendingAsks = new Map<string, (answers: string[]) => void>();
	private readonly scheduler: ToolScheduler;
	private readonly loopFactory: AgentLoopFactory;
	private readonly assistantBinding: AssistantSessionBinding;
	private readonly detachSessionProjection: () => void;
	private readonly queue: QueuedSubmit[] = [];
	private drainingQueue = false;
	private readonly idleWaiters: Array<() => void> = [];
	private sessionHooksStarted = false;

	constructor(private readonly deps: AgentControllerDeps) {
		this.assistantBinding =
			deps.assistantBinding ??
			new AssistantSessionBinding(deps.client, deps.session, deps.config.fresh);
		this.loopFactory = new AgentLoopFactory({
			client: deps.client,
			hookController: deps.hookController,
			assistantResolver: (assistantOptions) =>
				this.assistantBinding.resolve({
					systemPrompt: assistantOptions.systemPrompt,
					tools: assistantOptions.tools,
					signal: assistantOptions.signal,
				}),
		});
		this.scheduler = this.loopFactory.createScheduler({
			registry: deps.registry,
			bus: deps.bus,
			isToolEnabled: (name) => deps.config.isToolEnabled(name),
		});
		this.detachSessionProjection = deps.session.attach(deps.bus);
	}

	get isRunning(): boolean {
		return this.abortController !== null;
	}

	get hasActiveWork(): boolean {
		return (
			this.abortController !== null ||
			this.drainingQueue ||
			this.queue.length > 0
		);
	}

	get permissionMode(): PermissionMode {
		return this.deps.permissions.mode;
	}

	/** Shift+Tab: advance the mode and notify the UI. */
	cyclePermissionMode(): PermissionMode {
		const next = nextPermissionMode(this.deps.permissions.mode);
		this.deps.permissions.mode = next;
		this.deps.bus.emit({ type: "permission:mode", mode: next });
		return next;
	}

	get threadId(): string | null {
		return this.deps.session.threadId;
	}

	listToolNames(): string[] {
		return this.deps.registry.list().map((tool) => tool.name);
	}

	enableComputerUse(): void {
		this.deps.config.enableComputerUse();
	}

	setComputerUseEnabled(enabled: boolean): void {
		this.deps.config.setComputerUseEnabled(enabled);
	}

	get isComputerUseEnabled(): boolean {
		return this.deps.config.isComputerUseEnabled;
	}

	setSkillDiscoveryEnabled(enabled: boolean): void {
		this.deps.config.setSkillDiscoveryEnabled(enabled);
	}

	get isSkillDiscoveryEnabled(): boolean {
		return this.deps.config.isSkillDiscoveryEnabled;
	}

	enableBrowserUse(): void {
		this.deps.config.enableBrowserUse();
	}

	setBrowserUseEnabled(enabled: boolean): void {
		this.deps.config.setBrowserUseEnabled(enabled);
	}

	get isBrowserUseEnabled(): boolean {
		return this.deps.config.isBrowserUseEnabled;
	}

	hydrateSession(input: {
		threadId: string;
		assistantId?: string | null;
		messages: readonly Message[];
		pendingResume?: string;
	}): void {
		this.deps.session.hydrate(input);
		this.pendingAutoResume = input.pendingResume;
	}

	get pendingCompactionContext(): string | undefined {
		return this.pendingAutoResume;
	}

	async dispose(): Promise<void> {
		this.deps.agentTasks?.cancelAll();
		await this.deps.agentTasks?.waitForIdle();
		// Pair SessionEnd with SessionStart: only fire it if the session started.
		if (this.sessionHooksStarted) {
			await this.runTerminalHook((signal) =>
				this.deps.hookController?.runSessionEnd("exit", signal),
			);
		}
		await this.disposeTools();
		this.detachSessionProjection();
	}

	async submit(text: string, options: SubmitOptions = {}): Promise<TurnStatus> {
		return this.enqueueSubmit(text, "back", {
			emitUserMessage: options.emitUserMessage ?? true,
			onStart: options.onStart,
			turnId: options.turnId,
			attachmentFilePaths: options.attachmentFilePaths,
			displayContent: options.displayContent,
			conversationContext: options.conversationContext,
		});
	}

	async steer(text: string, options: SubmitOptions = {}): Promise<TurnStatus> {
		const shouldCancelActiveTurn = this.abortController !== null;
		const run = this.enqueueSubmit(text, "front", {
			emitUserMessage: options.emitUserMessage ?? false,
			onStart: options.onStart,
			turnId: options.turnId,
			attachmentFilePaths: options.attachmentFilePaths,
			displayContent: options.displayContent,
			conversationContext: options.conversationContext,
		});
		if (shouldCancelActiveTurn) this.cancel();
		return run;
	}

	private enqueueSubmit(
		text: string,
		placement: "front" | "back",
		options: Required<Pick<SubmitOptions, "emitUserMessage">> &
			Pick<
				SubmitOptions,
				| "onStart"
				| "turnId"
				| "attachmentFilePaths"
				| "displayContent"
				| "conversationContext"
			>,
	): Promise<TurnStatus> {
		const run = new Promise<TurnStatus>((resolve, reject) => {
			const queued = {
				text,
				emitUserMessage: options.emitUserMessage,
				onStart: options.onStart,
				turnId: options.turnId,
				attachmentFilePaths: options.attachmentFilePaths,
				displayContent: options.displayContent,
				conversationContext: options.conversationContext,
				resolve,
				reject,
			};
			if (placement === "front") {
				this.queue.unshift(queued);
			} else {
				this.queue.push(queued);
			}
		});
		void this.drainSubmitQueue();
		return run;
	}

	private async drainSubmitQueue(): Promise<void> {
		if (this.drainingQueue) return;
		this.drainingQueue = true;
		try {
			while (this.queue.length > 0) {
				const queued = this.queue.shift();
				if (!queued) continue;
				try {
					const cancellationVersion = this.cancellationVersion;
					const preparation = queued.onStart?.();
					if (preparation) await preparation;
					if (cancellationVersion !== this.cancellationVersion) {
						queued.resolve("cancelled");
						continue;
					}
					queued.resolve(
						await this.runTurn(queued.text, {
							emitUserMessage: queued.emitUserMessage,
							turnId: queued.turnId,
							attachmentFilePaths: queued.attachmentFilePaths,
							displayContent: queued.displayContent,
							conversationContext: queued.conversationContext,
						}),
					);
				} catch (err) {
					queued.reject(err);
				}
			}
		} finally {
			this.drainingQueue = false;
			for (const resolve of this.idleWaiters.splice(0)) resolve();
			if (this.queue.length > 0) void this.drainSubmitQueue();
		}
	}

	private async runTurn(
		text: string,
		options: {
			emitUserMessage: boolean;
			turnId?: string;
			attachmentFilePaths?: string[];
			displayContent?: string;
			conversationContext?: string;
		},
	): Promise<TurnStatus> {
		const { bus, session, config } = this.deps;
		const route: Readonly<ModelRoute> = Object.freeze({
			...config.model,
			source: config.modelSource,
		});
		const modelProfile = config.modelProfile;
		const thinkingIntent = config.thinkingIntent;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const turn = new Turn(options.turnId);
		let turnStarted = false;
		let finalStatus: TurnStatus = "failed";
		// The request baseline walks the whole workspace (seconds on a large
		// one). It only has to finish before the model can act, so it runs
		// alongside the other pre-request waits below instead of ahead of them,
		// and endTurn always waits for it.
		const baselineCapture = options.turnId
			? this.deps.checkpoints?.beginTurn?.(turn.id, text, config.cwd)
			: undefined;
		// Awaited (and its failure reported) below; this keeps an early exit
		// from leaving the rejection unobserved.
		baselineCapture?.catch(() => undefined);

		try {
			const hookController = this.deps.hookController;

			bus.emit({ type: "turn:start", turnId: turn.id });
			bus.emit({ type: "turn:status", turnId: turn.id, phase: "preparing" });

			let promptHook: UserPromptHookResult | undefined;
			if (hookController?.hasTrustedUserPromptHooks()) {
				// A hook may edit files: capture first so those edits stay
				// attributed to this turn, as they were before the overlap.
				await baselineCapture;
				promptHook = await this.runUserPromptHooks(turn.id, text, signal);
			}
			if (promptHook?.blockedReason) {
				bus.emit({
					type: "system:warning",
					message: `Prompt blocked by hook: ${promptHook.blockedReason}`,
				});
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "failed",
					durationMs: turn.durationMs(),
				});
				return "failed";
			}

			if (options.emitUserMessage) bus.emit({ type: "user:message", text });
			if (
				this.deps.autoCompact &&
				!this.pendingAutoResume &&
				this.needsCompaction()
			) {
				this.pendingAutoResume = await this.autoCompact(signal);
			}
			session.addMessage(userMessage(text));
			turnStarted = true;

			const ctx = { ...this.buildContext(signal), modelRoute: route };
			// All five are independent of each other: assistant resolution and
			// thinking metadata are network round-trips, the skill scan reads
			// only the skill catalog + filesystem, the tool sync talks to MCP
			// servers, and the baseline walks the workspace - none may stall the
			// others. The only orderings that matter are that syncDynamicTools
			// completes before visibleSchemas() below and that the baseline
			// exists before the first request lets the model run a tool, both of
			// which the single Promise.all preserves.
			// (In serve mode syncDynamicTools also waits, capped, for
			// in-flight MCP connects so their tools make this snapshot.)
			// An existing thread already knows its assistant, so skip the
			// resolution round-trip entirely.
			// Each wait reports its own duration, so a slow first token can be
			// traced to the stage that held it.
			const prepareStartedAt = performance.now();
			const timed = async <T>(
				phase: PerformanceTimingPhase,
				work: Promise<T> | T,
			): Promise<T> => {
				const result = await work;
				bus.emit({
					type: "performance:timing",
					phase,
					durationMs: performance.now() - prepareStartedAt,
				});
				return result;
			};
			const [, skillPromptContext, assistantId, thinkingResolver] =
				await Promise.all([
					timed("prepare_tools", this.deps.syncDynamicTools?.(signal)),
					timed(
						"prepare_skills",
						this.deps.skillController.buildPromptContext(text),
					),
					// A key-backed model has no assistant record to resolve, and an
					// existing thread already knows its assistant - either way the
					// round-trip is skipped.
					timed(
						"prepare_assistant",
						!this.deps.client.capabilities.assistants || session.threadId
							? (session.assistantId ?? undefined)
							: this.loopFactory.resolveAssistantId({
									systemPrompt: this.baseSystemPrompt(),
									tools: this.baseTools(),
									signal,
								}),
					),
					timed(
						"prepare_thinking",
						createRuntimeThinkingResolver(
							{ model: route, modelSource: route.source, thinkingIntent },
							this.deps.client,
						),
					),
					timed("prepare_baseline", baselineCapture),
				]);
			const promptProfile = toPromptProfileId(modelProfile.name);
			const tools = config.toolPolicy.visibleSchemas(
				this.deps.registry,
				[],
				promptProfile,
			);
			const enabledTools = tools.map((tool) => tool.function.name);
			// Backboard's hosted media tools only run on Backboard-billed turns. A
			// key or subscription turn never reaches them, so it must not promise
			// them, send their fields, or hold its answer back for them.
			const mediaRoute = {
				source: billingSource(
					route.source ?? this.deps.client.sourceFor?.(route),
				),
				provider: route.provider,
			};
			const backboardMedia = mediaRoute.source === "backboard";
			const todoWriteAvailable = enabledTools.some(
				(name) => canonicalToolName(name) === "todo_write",
			);
			// Re-invoked for injected notification requests, so the reminder
			// disappears as soon as TodoWrite runs mid-turn.
			const buildTurnSystemPrompt = () =>
				getSystemPrompt({
					layout: modelProfile.systemPromptLayout,
					profile: promptProfile,
					enabledTools,
					...skillPromptContext,
					computerUseEnabled: config.isComputerUseEnabled,
					browserUseEnabled: config.isBrowserUseEnabled,
					mediaGenerationPrompt: buildGenerativeMediaPrompt({
						...(backboardMedia
							? {
									imageModel: config.selectedImageModel,
									videoModel: config.selectedVideoModel,
									askBeforeGenerating: config.isAskBeforeGeneratingEnabled,
								}
							: {}),
						route: mediaRoute,
						...readCanvasProject(config.cwd),
					}),
					clientToolsEnabled: this.deps.registry
						.list()
						.some((tool) => tool instanceof ClientProxyTool),
					skillDiscoveryEnabled: config.isSkillDiscoveryEnabled,
					startupEnvironmentPrompt: this.deps.startupEnvironmentPrompt,
					conversationContext: options.conversationContext,
					hookContext: joinHookContext(
						this.deps.hookController?.baseContext,
						promptHook?.additionalContext,
					),
					todoReminderPrompt:
						todoWriteAvailable && !session.hasUsedTodoWrite
							? TODO_NOT_CALLED_REMINDER
							: undefined,
				});
			const systemPrompt = buildTurnSystemPrompt();
			let fallbackCandidatesPromise: Promise<ModelRef[]> | null = null;
			const resolveCapacityFallback = async (
				_current: ModelRef,
				attemptedModelKeys: ReadonlySet<string>,
			): Promise<ModelRef | null> => {
				// A key-billed turn has exactly one place to go: no other model may
				// be billed to the key on its behalf, and Backboard must not pay
				// for a turn the user routed to their own key.
				if (route.source === "byok") return null;
				fallbackCandidatesPromise ??= this.deps.client
					.listModels({ signal })
					.then((catalog) =>
						capacityFallbackCandidates(
							normalizeSelectableModels(catalog.models),
							config.successfulModels,
						),
					)
					// A catalog outage should not erase the locally known good route.
					.catch(() => config.successfulModels);
				const candidates = await fallbackCandidatesPromise;
				return (
					candidates.find(
						(candidate) =>
							!attemptedModelKeys.has(modelKey(candidate)) &&
							this.canUseFallbackInCurrentThread(candidate),
					) ?? null
				);
			};
			const resolveFreeFallback = async (
				_current: ModelRef,
				attemptedModelKeys: ReadonlySet<string>,
			): Promise<ModelRef | null> => {
				// A key-billed turn is never blocked on Backboard credit, and must
				// not be moved off the user's key.
				if (route.source === "byok") return null;
				const catalog = await this.deps.client
					.listModels({ signal })
					.catch(() => null);
				if (!catalog) return null;
				return (
					freeFallbackCandidates(
						normalizeSelectableModels(catalog.models),
					).find(
						(candidate) =>
							!attemptedModelKeys.has(modelKey(candidate)) &&
							this.canUseFallbackInCurrentThread(candidate),
					) ?? null
				);
			};
			const loop = this.loopFactory.createLoop({
				scheduler: this.scheduler,
				session,
				bus,
				tools,
				systemPrompt,
				refreshSystemPrompt: buildTurnSystemPrompt,
				assistantId,
				model: { provider: route.provider, model: route.model },
				source: route.source,
				memory: config.memory,
				memoryProfile: config.memoryProfile,
				workspaceId:
					config.memory === "off" ? undefined : config.getWorkspaceId(),
				imageGeneration: backboardMedia && config.isImageGenerationEnabled,
				imageModel: backboardMedia ? config.selectedImageModel : undefined,
				videoGeneration: backboardMedia && config.isVideoGenerationEnabled,
				videoModel: backboardMedia ? config.selectedVideoModel : undefined,
				openRouterProvider: config.selectedOpenRouterProvider,
				generatedMediaDir: join(config.cwd, "generated-images"),
				generatedVideoDir: join(config.cwd, "generated-videos"),
				thinking: undefined,
				thinkingResolver,
				requestKind: "user",
				finalVerificationNudge:
					this.deps.finalVerificationNudge ?? config.finalVerificationNudge,
				todoReconciliation: this.deps.todoReconciliation,
				turnId: turn.id,
				turnStartedAt: turn.startedAt,
				turnAlreadyStarted: true,
				attachmentFilePaths: options.attachmentFilePaths?.length
					? options.attachmentFilePaths
					: undefined,
				displayContent: options.displayContent ?? text,
				durableSession: this.deps.getDurableSession,
				resolveCapacityFallback,
				resolveFreeFallback,
				maxTurnAttempts: TURN_MAX_ATTEMPTS,
				turnRetryBackoffMs: this.deps.turnRetryBackoffMs,
				...(this.deps.autoCompact
					? {
							// Claude Code owns a Claude subscription's live session, so it
							// is the one that compresses mid-turn there (see
							// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE); a reset from out here
							// would strand its parked query.
							...(route.provider === "anthropic-subscription"
								? {}
								: {
										needsCompaction: (pendingTokens: number) =>
											this.needsCompaction(pendingTokens),
									}),
							compactContext: (compactSignal: AbortSignal) =>
								this.autoCompact(compactSignal),
							beforeTurnEnd: async (endSignal: AbortSignal) => {
								// Leave nothing above the line between turns: the
								// context ring would sit there until the next message.
								if (this.needsCompaction()) {
									this.pendingAutoResume = await this.autoCompact(endSignal);
								}
							},
						}
					: {}),
				onModelSucceeded: async (model) => {
					try {
						if (
							modelKey(model) !== modelKey(route) &&
							modelKey(config.model) === modelKey(route) &&
							config.modelSource === route.source
						) {
							config.setModel({ ...model }, route.source);
							await config.saveRecoverySelection();
						}
						await config.recordSuccessfulModel(model);
					} catch {
						// Recovery history is best-effort and must never fail a good turn.
					}
				},
				onThinkingDisabled: async () => {
					config.setThinking(null);
					await config.saveRecoverySelection().catch(() => undefined);
				},
			});

			bus.emit({ type: "turn:status", turnId: turn.id, phase: "generating" });
			const sentResume = this.pendingAutoResume;
			finalStatus = await loop.run(
				sentResume ? `${sentResume}\n\n${text}` : text,
				ctx,
			);
			// The resume has landed once the turn completed or a new thread was
			// opened with it; carrying it further would prepend it again on every
			// retry. One set at the end of this turn (a fresh compression) stays.
			if (
				sentResume !== undefined &&
				this.pendingAutoResume === sentResume &&
				(finalStatus === "completed" || session.threadId !== null)
			) {
				this.pendingAutoResume = undefined;
			}
			return finalStatus;
		} catch (err) {
			if (signal.aborted) {
				finalStatus = "cancelled";
				bus.emit({ type: "turn:cancelled", turnId: turn.id });
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "cancelled",
					durationMs: turn.durationMs(),
				});
				return finalStatus;
			}
			finalStatus = "failed";
			bus.emit({
				type: "run:error",
				error: formatSubmitError(err),
				...(isAccountBlockedError(err) ? { actionable: true } : {}),
			});
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status: "failed",
				durationMs: turn.durationMs(),
			});
			return finalStatus;
		} finally {
			try {
				// Stop runs for every turn that actually started, whatever the outcome.
				if (turnStarted) await this.runStopHooks(turn.id, finalStatus);
				await this.disposeTools();
				if (options.turnId) {
					// The boundary closes only after it was opened, even when the
					// turn ended before reaching the pre-request waits.
					await baselineCapture?.catch(() => undefined);
					await this.deps.checkpoints?.endTurn?.(turn.id);
				}
			} finally {
				this.abortController = null;
				this.rejectPendingAsks();
			}
		}
	}

	private canUseFallbackInCurrentThread(model: ModelRef): boolean {
		const threadId = this.deps.session.threadId;
		if (!threadId) return true;
		const canServe = this.deps.client.canServeThread?.(model, threadId);
		if (canServe !== undefined) return canServe;
		const modelSource = this.deps.client.sourceFor?.(model);
		const threadSource = this.deps.client.sourceForThread?.(threadId);
		return !modelSource || !threadSource || modelSource === threadSource;
	}

	private async runUserPromptHooks(
		turnId: string,
		text: string,
		signal: AbortSignal,
	): Promise<UserPromptHookResult> {
		const hookController = this.deps.hookController;
		if (!hookController) return {};
		return await hookController.runUserPromptSubmit({
			turnId,
			prompt: text,
			signal,
		});
	}

	private async runStopHooks(
		turnId: string,
		status: TurnStatus,
	): Promise<void> {
		// Always bound Stop like SessionEnd so a slow hook can't block teardown.
		await this.runTerminalHook((signal) =>
			this.deps.hookController?.runStop({ turnId, status, signal }),
		);
	}

	private async runTerminalHook(
		run: (signal: AbortSignal) => Promise<void> | undefined,
	): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			TERMINAL_HOOK_TIMEOUT_MS,
		);
		try {
			await run(controller.signal);
		} catch {
			// Terminal hooks are best-effort.
		} finally {
			clearTimeout(timer);
		}
	}

	/** Runs SessionStart once at init; SessionEnd is paired in dispose(). */
	async start(): Promise<void> {
		if (this.sessionHooksStarted) return;
		this.sessionHooksStarted = true;
		const hookController = this.deps.hookController;
		if (!hookController) return;
		const controller = new AbortController();
		try {
			await hookController.runSessionStart("startup", controller.signal);
		} catch {
			// Best-effort; never block startup on a hook failure.
		}
	}

	/**
	 * Seeds the context window from the catalog entry the user just picked, so
	 * `/context` is right immediately rather than after the first turn.
	 */
	setModelContextLimit(limit: number | null): void {
		this.deps.session.setContextLimit(limit);
	}

	/**
	 * Snapshot of what is filling the context window, for `/context`. Reads the
	 * same prompt and tool schemas a turn would send, so the breakdown reflects
	 * the real request rather than an idealized one.
	 */
	contextReport(source = "backboard"): ContextReport {
		const { config, session } = this.deps;
		return buildContextReport({
			model: config.model,
			source,
			systemPrompt: this.baseSystemPrompt(),
			tools: this.baseTools(),
			messages: session.getMessages(),
			todos: session.todos,
			usedTokens: session.contextTokens,
			reportedLimit: session.reportedContextLimit,
			cachedTokens: session.cachedTokens,
			compactThresholdPercent: AUTO_COMPACT_THRESHOLD_PERCENT,
		});
	}

	/**
	 * True once the last measured turn crossed the auto-compression threshold.
	 * The UI checks this after a turn ends, never during one.
	 */
	needsCompaction(pendingTokens = 0): boolean {
		const report = this.contextReport();
		return shouldAutoCompact({
			usedTokens:
				(report.measured ? report.usedTokens : report.estimatedTotal) +
				pendingTokens,
			limit: report.limit,
			messageCount: report.messageCount,
		});
	}

	/**
	 * Automatic compression: never fails the turn (a summary that cannot be
	 * made falls back to trimming), keeps the resume in local history for the
	 * next compression, and reports the emptied window right away so the
	 * context ring drops instead of holding the old level until the next
	 * provider usage arrives. Returns the context the next request carries.
	 */
	private async autoCompact(signal: AbortSignal): Promise<string> {
		const { bus, session } = this.deps;
		bus.emit({
			type: "system:warning",
			message: "Summarizing earlier messages to free up context…",
		});
		const result = await this.compactSession(signal, { fallbackToTrim: true });
		session.addMessage(userMessage(result.resumeContext));
		// Bus only: the session keeps measuring from real provider usage.
		const report = this.contextReport();
		bus.emit({
			type: "usage",
			usage: {
				contextTokens: report.estimatedTotal,
				contextLimit: report.limit,
			},
		});
		return result.resumeContext;
	}

	get canCompact(): boolean {
		return new Compactor({
			client: this.deps.client,
			session: this.deps.session,
			config: this.deps.config,
		}).canCompact();
	}

	/**
	 * Compresses the conversation and restarts the thread from a handoff
	 * document. Returns the context the caller must carry into the next turn.
	 */
	async compact(signal?: AbortSignal): Promise<CompactionResult> {
		if (this.abortController) {
			throw new CompactionError(
				"Finish or cancel the current turn before compressing.",
			);
		}
		return this.compactSession(signal);
	}

	private async compactSession(
		signal?: AbortSignal,
		options: { fallbackToTrim?: boolean } = {},
	): Promise<CompactionResult> {
		const transcriptPath =
			this.deps.getTranscriptPath?.() ?? this.deps.transcriptPath;
		const compactor = new Compactor({
			client: this.deps.client,
			session: this.deps.session,
			config: this.deps.config,
			bus: this.deps.bus,
			...(transcriptPath ? { transcriptPath } : {}),
		});
		const replacedThreadId = this.deps.session.threadId;
		const result = await compactor.compact({
			...(signal === undefined ? {} : { signal }),
			...options,
		});
		const replacedSource = replacedThreadId
			? this.deps.client.sourceForThread?.(replacedThreadId)
			: undefined;
		// Locally stored conversations (API key and subscription) keep one slot
		// per session; the new thread may only take it over when it names the
		// thread it replaces. Without that, the save is refused and the chat
		// fails with "Unknown … conversation" after the next restart.
		this.deps.onThreadReplaced?.(
			replacedThreadId && replacedSource !== "backboard"
				? replacedThreadId
				: null,
		);
		// The thread was reset, so the assistant binding for the old thread is
		// stale too; a new one is resolved on the next turn.
		this.deps.session.assistantId = null;
		return result;
	}

	/** Hashes only; prompt contents and schemas can contain private instructions. */
	get runtimePromptIdentity() {
		return {
			promptVersion: PROMPT_VERSION,
			promptHash: fingerprint(this.baseSystemPrompt()),
			schemaHash: fingerprint(this.baseTools()),
			scope: "startup-base",
		};
	}

	private baseSystemPrompt(): string {
		const enabledTools = this.baseTools().map((tool) => tool.function.name);
		return getSystemPrompt({
			enabledTools,
			startupEnvironmentPrompt: this.deps.startupEnvironmentPrompt,
		});
	}

	private baseTools(): OpenAITool[] {
		return this.deps.config.toolPolicy.visibleSchemas(
			this.deps.registry,
			this.baseToolSchemaExcludedNames(),
		);
	}

	private baseToolSchemaExcludedNames(): string[] {
		const excluded = new Set(this.deps.config.toolSchemaExcludedNames);
		excluded.add("browser");
		excluded.add("computer");
		for (const tool of this.deps.registry.list()) {
			if (tool.agentName.startsWith("mcp__")) excluded.add(tool.agentName);
		}
		return [...excluded];
	}

	/** Cancels the active turn, aborting in-flight requests and tools. */
	cancel(options: CancelOptions = {}): void {
		this.cancellationVersion++;
		this.abortController?.abort();
		this.deps.agentTasks?.cancelAll();
		this.rejectPendingAsks();
		if (options.clearQueue) this.clearQueuedSubmits();
	}

	async waitForIdle(): Promise<void> {
		if (this.drainingQueue)
			await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		await this.deps.agentTasks?.waitForIdle();
	}

	/** Cancels any active turn and starts a fresh Backboard thread. */
	newThread(): void {
		this.cancel({ clearQueue: true });
		this.pendingAutoResume = undefined;
		this.deps.session.reset();
	}

	/** Resolves a pending AskUser request raised by a tool. */
	provideInput(id: string, answers: string[]): void {
		const resolve = this.pendingAsks.get(id);
		if (resolve) {
			this.pendingAsks.delete(id);
			this.deps.bus.emit({ type: "input:response", response: { id, answers } });
			resolve(answers);
		}
	}

	private buildContext(signal: AbortSignal): ToolContext {
		const durable = this.deps.getDurableSession?.();
		return {
			sessionId: durable?.sessionId ?? this.deps.session.sessionId,
			cwd: this.deps.config.cwd,
			bus: this.deps.bus,
			signal,
			askUser: (question, options, promptSignal) =>
				this.askQuestions([{ question, options }], promptSignal ?? signal).then(
					(answers) => answers[0] ?? "",
				),
			askQuestions: (questions) => this.askQuestions(questions, signal),
			getTodos: () => this.deps.session.todos,
			agentDepth: 0,
			lsp: this.deps.lsp,
			checkpoints: this.deps.checkpoints,
			permissions: this.deps.permissions,
			trace: new AgentTraceContext({
				sessionId: durable?.sessionId ?? this.deps.session.sessionId,
				sessionRoot:
					durable?.sessionRoot ??
					qSessionDir(this.deps.config.cwd, this.deps.session.sessionId),
				cwd: this.deps.config.cwd,
			}),
		};
	}

	private clearQueuedSubmits(): void {
		const queued = this.queue.splice(0);
		for (const submit of queued) {
			submit.resolve("cancelled");
		}
	}

	private askQuestions(
		questions: AskUserQuestionSpec[],
		signal: AbortSignal,
	): Promise<string[]> {
		if (signal.aborted) return Promise.reject(new Error("aborted"));
		const id = shortId("ask");
		this.deps.bus.emit({
			type: "input:request",
			request: { id, questions },
		});

		return new Promise<string[]>((resolve, reject) => {
			this.pendingAsks.set(id, resolve);
			signal.addEventListener(
				"abort",
				() => {
					if (this.pendingAsks.delete(id)) {
						this.deps.bus.emit({
							type: "input:response",
							response: { id, answers: [] },
						});
						reject(new Error("aborted"));
					}
				},
				{ once: true },
			);
		});
	}

	private rejectPendingAsks(): void {
		this.pendingAsks.clear();
	}

	private async disposeTools(): Promise<void> {
		for (const tool of this.deps.registry.list()) {
			try {
				await tool.dispose();
			} catch (err) {
				this.deps.bus.emit({
					type: "run:error",
					error: `Tool cleanup failed for ${tool.name}: ${formatSubmitError(err)}`,
				});
			}
		}
	}
}

function formatSubmitError(err: unknown): string {
	if (err instanceof BackboardError) {
		return `${err.message}: ${JSON.stringify(err.body)}`;
	}
	return errorMessage(err);
}

/** A client's route name as a billing source; unknown names are Backboard's. */
function billingSource(source: string | undefined): ModelSource {
	return source === "byok" || source === "subscription" ? source : "backboard";
}

/** Whether `cwd` is a Canvas project, and the media defaults its board file holds. */
function readCanvasProject(cwd: string): {
	canvasProject: boolean;
	canvasSettings?: CanvasProjectSettings;
} {
	const file = join(cwd, CANVAS_PROJECT_FILE);
	if (!existsSync(file)) {
		return { canvasProject: false };
	}
	try {
		const canvasSettings = parseCanvasProjectSettings(
			readFileSync(file, "utf8"),
		);
		return {
			canvasProject: true,
			...(canvasSettings ? { canvasSettings } : {}),
		};
	} catch {
		return { canvasProject: true };
	}
}
