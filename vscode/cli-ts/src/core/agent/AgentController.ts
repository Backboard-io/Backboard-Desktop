import type { Config } from "../../config/Config.ts";
import { qSessionDir } from "../../config/paths.ts";
import { createRuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import { toPromptProfileId } from "../../prompts/profiles/ids.ts";
import { getSystemPrompt } from "../../prompts/system/index.tsx";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import { BackboardError } from "../../providers/backboard/errors.ts";
import { shortId } from "../../utils/id.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus } from "../bus/events.ts";
import { TERMINAL_HOOK_TIMEOUT_MS } from "../hooks/constants.ts";
import {
	type HookController,
	joinHookContext,
	type UserPromptHookResult,
} from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import { userMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";
import type { SkillController } from "../skills/SkillController.ts";
import type { OpenAITool } from "../tools/schema.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolPermissionGate } from "../tools/ToolPermissionGate.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import type {
	CancelOptions,
	QueuedSubmit,
	SubmitOptions,
} from "./AgentControllerTypes.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import { AgentTraceContext } from "./AgentTraceStore.ts";
import { AssistantSessionBinding } from "./AssistantSessionBinding.ts";
import { Turn } from "./Turn.ts";

export interface AgentControllerDeps {
	config: Config;
	bus: EventBus;
	session: Session;
	registry: ToolRegistry;
	client: BackboardClient;
	skillController: SkillController;
	hookController?: HookController;
	permissionGate?: ToolPermissionGate;
	assistantBinding?: AssistantSessionBinding;
	syncDynamicTools?: (signal: AbortSignal) => Promise<void>;
	startupEnvironmentPrompt?: string;
	lsp?: LspService;
}

/**
 * Public facade the UI talks to. Owns per-turn cancellation, the AskUser bridge
 * between tools and the UI, and the wiring of a fresh AgentLoop per submission.
 */
export class AgentController {
	private abortController: AbortController | null = null;
	private readonly pendingAsks = new Map<string, (answer: string) => void>();
	private readonly scheduler: ToolScheduler;
	private readonly loopFactory: AgentLoopFactory;
	private readonly assistantBinding: AssistantSessionBinding;
	private readonly detachSessionProjection: () => void;
	private readonly queue: QueuedSubmit[] = [];
	private drainingQueue = false;
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

	listToolNames(): string[] {
		return this.deps.registry.list().map((tool) => tool.name);
	}

	enableComputerUse(): void {
		this.deps.config.enableComputerUse();
	}

	enableBrowserUse(): void {
		this.deps.config.enableBrowserUse();
	}

	async dispose(): Promise<void> {
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
		});
	}

	async steer(text: string, options: SubmitOptions = {}): Promise<TurnStatus> {
		const shouldCancelActiveTurn = this.abortController !== null;
		const run = this.enqueueSubmit(text, "front", {
			emitUserMessage: options.emitUserMessage ?? false,
			onStart: options.onStart,
		});
		if (shouldCancelActiveTurn) this.cancel();
		return run;
	}

	private enqueueSubmit(
		text: string,
		placement: "front" | "back",
		options: Required<Pick<SubmitOptions, "emitUserMessage">> &
			Pick<SubmitOptions, "onStart">,
	): Promise<TurnStatus> {
		const run = new Promise<TurnStatus>((resolve, reject) => {
			const queued = {
				text,
				emitUserMessage: options.emitUserMessage,
				onStart: options.onStart,
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
					queued.onStart?.();
					queued.resolve(
						await this.runTurn(queued.text, {
							emitUserMessage: queued.emitUserMessage,
						}),
					);
				} catch (err) {
					queued.reject(err);
				}
			}
		} finally {
			this.drainingQueue = false;
			if (this.queue.length > 0) void this.drainSubmitQueue();
		}
	}

	private async runTurn(
		text: string,
		options: { emitUserMessage: boolean },
	): Promise<TurnStatus> {
		const { bus, session, config } = this.deps;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const turn = new Turn();
		let turnStarted = false;
		let finalStatus: TurnStatus = "failed";

		try {
			const hookController = this.deps.hookController;

			bus.emit({ type: "turn:start", turnId: turn.id });

			let promptHook: UserPromptHookResult | undefined;
			if (hookController?.hasTrustedUserPromptHooks()) {
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
			session.addMessage(userMessage(text));
			turnStarted = true;

			const ctx = this.buildContext(signal);
			await this.deps.syncDynamicTools?.(signal);
			const skillPromptContext =
				await this.deps.skillController.buildPromptContext(text);
			const promptProfile = toPromptProfileId(config.modelProfile.name);
			const tools = config.toolPolicy.visibleSchemas(
				this.deps.registry,
				[],
				promptProfile,
			);
			const enabledTools = tools.map((tool) => tool.function.name);
			const systemPrompt = getSystemPrompt({
				layout: config.modelProfile.systemPromptLayout,
				profile: promptProfile,
				enabledTools,
				...skillPromptContext,
				computerUseEnabled: config.isComputerUseEnabled,
				browserUseEnabled: config.isBrowserUseEnabled,
				startupEnvironmentPrompt: this.deps.startupEnvironmentPrompt,
				hookContext: joinHookContext(
					this.deps.hookController?.baseContext,
					promptHook?.additionalContext,
				),
			});
			const assistantId = await this.loopFactory.resolveAssistantId({
				systemPrompt: this.baseSystemPrompt(),
				tools: this.baseTools(),
				signal,
			});
			const thinkingResolver = await createRuntimeThinkingResolver(
				config,
				this.deps.client,
			);

			const loop = this.loopFactory.createLoop({
				scheduler: this.scheduler,
				session,
				bus,
				tools,
				systemPrompt,
				assistantId,
				model: config.model,
				memory: config.memory,
				memoryProfile: config.memoryProfile,
				thinking: undefined,
				thinkingResolver,
				requestKind: "user",
				finalVerificationNudge: config.finalVerificationNudge,
				turnId: turn.id,
				turnStartedAt: turn.startedAt,
				turnAlreadyStarted: true,
			});

			finalStatus = await loop.run(text, ctx);
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
			});
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status: "failed",
				durationMs: turn.durationMs(),
			});
			return finalStatus;
		} finally {
			// Stop runs for every turn that actually started, whatever the outcome.
			if (turnStarted) await this.runStopHooks(turn.id, finalStatus);
			await this.disposeTools();
			this.abortController = null;
			this.rejectPendingAsks();
		}
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
		this.abortController?.abort();
		this.rejectPendingAsks();
		if (options.clearQueue) this.clearQueuedSubmits();
	}

	/** Cancels any active turn and starts a fresh Backboard thread. */
	newThread(): void {
		this.cancel({ clearQueue: true });
		this.deps.session.reset();
	}

	/** Resolves a pending AskUser request raised by a tool. */
	provideInput(id: string, answer: string): void {
		const resolve = this.pendingAsks.get(id);
		if (resolve) {
			this.pendingAsks.delete(id);
			this.deps.bus.emit({ type: "input:response", response: { id, answer } });
			resolve(answer);
		}
	}

	private buildContext(signal: AbortSignal): ToolContext {
		const permissionGate = this.deps.permissionGate;
		return {
			sessionId: this.deps.session.sessionId,
			cwd: this.deps.config.cwd,
			bus: this.deps.bus,
			signal,
			askUser: (question, options) => this.askUser(question, options, signal),
			requestPermission: permissionGate
				? (request) => permissionGate.request(request, signal)
				: undefined,
			getTodos: () => this.deps.session.todos,
			agentDepth: 0,
			lsp: this.deps.lsp,
			trace: new AgentTraceContext({
				sessionId: this.deps.session.sessionId,
				sessionRoot: qSessionDir(
					this.deps.config.cwd,
					this.deps.session.sessionId,
				),
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

	private askUser(
		question: string,
		options: string[],
		signal: AbortSignal,
	): Promise<string> {
		const id = shortId("ask");
		this.deps.bus.emit({
			type: "input:request",
			request: { id, question, options },
		});

		return new Promise<string>((resolve, reject) => {
			this.pendingAsks.set(id, resolve);
			signal.addEventListener(
				"abort",
				() => {
					if (this.pendingAsks.delete(id)) reject(new Error("aborted"));
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
	return err instanceof Error ? err.message : String(err);
}
