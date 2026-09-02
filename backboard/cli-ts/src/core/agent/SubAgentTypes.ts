import type {
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus, UsageInfo } from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import type { HookController } from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type { Tool } from "../tools/Tool.ts";
import type { ToolTraceContext } from "../tools/ToolContext.ts";
import type { WorkerWorkspaceProgress } from "../workspaces/WorkerWorkspaceTypes.ts";

export type SubAgentToolFactory = (opts: {
	depth: number;
	readOnly: boolean;
}) => Tool[];

export interface SubAgentRunnerDeps {
	client: AgentClient;
	getModel: () => ModelRef;
	getOpenRouterProvider?: () => string | undefined;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	getThinking: () => Promise<ThinkingConfig | null | undefined>;
	getThinkingResolver?: () => Promise<RuntimeThinkingResolver>;
	systemPrompt: string;
	toolFactory: SubAgentToolFactory;
	isToolEnabled?: (name: string) => boolean;
	hookController?: HookController;
	lsp?: LspService;
	checkpoints?: CheckpointRecorder;
}

export interface SubAgentRunParams {
	prompt: string;
	depth: number;
	/** True when the worker must not receive workspace-mutating tools. */
	readOnly?: boolean;
	parentCwd: string;
	/** Coordinator root corresponding to parentCwd before worker rebasing. */
	permissionCwd?: string;
	parentSignal: AbortSignal;
	/** True when write tools run in a dedicated native Git worktree. */
	isolatedWorkspace?: boolean;
	workspace?: WorkerWorkspaceProgress;
	parentBus?: EventBus;
	parentToolCallId?: string;
	/**
	 * An isolated workspace coordinator owns the authoritative terminal edge:
	 * model EOF is provisional until result capture/integration has settled.
	 */
	deferParentEnd?: boolean;
	/**
	 * The user turn the spawning tool call belongs to. Sub-agent file edits
	 * are journaled under this turn so they fold into the parent checkpoint
	 * (the sub-agent's own turns are never finalized on the main bus).
	 */
	parentTurnId?: string;
	/**
	 * Capture surface from the spawning tool's context. Preferred over
	 * `deps.checkpoints` so nested sub-agents keep the root turn attribution.
	 */
	checkpoints?: CheckpointRecorder;
	parentPermissions?: PermissionContext;
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
