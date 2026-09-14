import type {
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
import { ensureAssistant } from "../../providers/backboard/assistants.ts";
import type { ModelSource } from "../../providers/backboard/types.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { HookController } from "../hooks/index.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import { ToolScheduler } from "../tools/ToolScheduler.ts";
import {
	AgentLoop,
	type CapacityFallbackResolver,
	type ModelSucceededHandler,
	type ThinkingDisabledHandler,
} from "./AgentLoop.ts";

export interface AgentLoopFactoryDeps {
	client: AgentClient;
	hookController?: HookController;
	assistantResolver?: (options: ResolveAssistantOptions) => Promise<string>;
}

export interface CreateSchedulerOptions {
	registry: ToolRegistry;
	bus: EventBus;
	isToolEnabled?: (name: string) => boolean;
}

export interface CreateLoopOptions {
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	tools: OpenAITool[];
	systemPrompt: string;
	refreshSystemPrompt?: () => string;
	assistantId?: string;
	model: ModelRef;
	/** The billing route captured for this loop; see AgentLoopDeps.source. */
	source?: ModelSource;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	imageGeneration?: boolean;
	openRouterProvider?: string;
	generatedMediaDir?: string;
	thinking?: ThinkingConfig | null;
	thinkingResolver?: RuntimeThinkingResolver;
	requestKind: ThinkingRequestKind;
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

export interface ResolveAssistantOptions {
	systemPrompt: string;
	tools: OpenAITool[];
	signal: AbortSignal;
}

export class AgentLoopFactory {
	constructor(private readonly deps: AgentLoopFactoryDeps) {}

	createScheduler(options: CreateSchedulerOptions): ToolScheduler {
		return new ToolScheduler(
			options.registry,
			options.bus,
			options.isToolEnabled,
			this.deps.hookController,
		);
	}

	async resolveAssistantId(options: ResolveAssistantOptions): Promise<string> {
		if (this.deps.assistantResolver) {
			return this.deps.assistantResolver(options);
		}
		return ensureAssistant(
			this.deps.client,
			options.systemPrompt,
			options.tools,
			{
				signal: options.signal,
			},
		);
	}

	createLoop(options: CreateLoopOptions): AgentLoop {
		return new AgentLoop({
			client: this.deps.client,
			scheduler: options.scheduler,
			session: options.session,
			bus: options.bus,
			tools: options.tools,
			systemPrompt: options.systemPrompt,
			refreshSystemPrompt: options.refreshSystemPrompt,
			assistantId: options.assistantId,
			model: options.model,
			source: options.source,
			memory: options.memory,
			memoryProfile: options.memoryProfile,
			workspaceId: options.workspaceId,
			imageGeneration: options.imageGeneration,
			openRouterProvider: options.openRouterProvider,
			generatedMediaDir: options.generatedMediaDir,
			thinking: options.thinking,
			thinkingResolver: options.thinkingResolver,
			requestKind: options.requestKind,
			finalVerificationNudge: options.finalVerificationNudge,
			todoReconciliation: options.todoReconciliation,
			turnId: options.turnId,
			turnStartedAt: options.turnStartedAt,
			turnAlreadyStarted: options.turnAlreadyStarted,
			maxToolRounds: options.maxToolRounds,
			attachmentFilePaths: options.attachmentFilePaths,
			displayContent: options.displayContent,
			durableSession: options.durableSession,
			resolveCapacityFallback: options.resolveCapacityFallback,
			onModelSucceeded: options.onModelSucceeded,
			onThinkingDisabled: options.onThinkingDisabled,
		});
	}
}
