import type {
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus, UsageInfo } from "../bus/events.ts";
import type { HookController } from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import type { Tool } from "../tools/Tool.ts";
import type { ToolTraceContext } from "../tools/ToolContext.ts";

export type SubAgentToolFactory = (opts: { depth: number }) => Tool[];

export interface SubAgentRunnerDeps {
	client: BackboardClient;
	getModel: () => ModelRef;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	getThinking: () => Promise<ThinkingConfig | null | undefined>;
	getThinkingResolver?: () => Promise<RuntimeThinkingResolver>;
	systemPrompt: string;
	toolFactory: SubAgentToolFactory;
	isToolEnabled?: (name: string) => boolean;
	hookController?: HookController;
	lsp?: LspService;
}

export interface SubAgentRunParams {
	prompt: string;
	depth: number;
	parentCwd: string;
	parentSignal: AbortSignal;
	parentBus?: EventBus;
	parentToolCallId?: string;
	trace?: {
		sessionId: string;
		context: ToolTraceContext;
		clientLogPath: string;
	};
}

export interface SubAgentResult {
	report: string;
	status: TurnStatus;
	usage: UsageInfo;
	toolRounds: number;
}
