import { z } from "zod";
import type { Config } from "../config/Config.ts";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type { RLMLoop } from "../core/agent/rlm/RLMLoop.ts";
import type { JSONObject } from "../core/agent/rlm/RLMTypes.ts";
import type { SubAgentRunner } from "../core/agent/SubAgentRunner.ts";
import type { CheckpointRecorder } from "../core/checkpoints/CheckpointStore.ts";
import type { HookController } from "../core/hooks/index.ts";
import type { LspService } from "../core/lsp/index.ts";
import type { AgentMode } from "../core/tools/AgentToolOutput.ts";
import type { Tool } from "../core/tools/Tool.ts";
import type { WorkerWorkspaceManager } from "../core/workspaces/WorkerWorkspaceManager.ts";
import type { AgentClient } from "../providers/AgentClient.ts";
import type { ModelRoute } from "../providers/backboard/types.ts";
import type { McpRegistrar } from "./FindMcpTool.tsx";
import type { SkillActivator } from "./FindSkillTool.tsx";

export type {
	AgentMode,
	AgentToolOutput,
} from "../core/tools/AgentToolOutput.ts";

export interface AgentToolInput {
	/** Cosmetic display label; never a worker id or replay key. */
	name?: string;
	subagent_type?: AgentMode;
	prompt: string;
	/** Restricts a worker to non-mutating workspace tools. */
	read_only?: boolean;
	variables?: JSONObject;
	timeout_ms?: number;
}

export const agentDisplayNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\r\n]+$/, "Use a single-line name.")
	.optional()
	.describe(
		"Optional short display label for this worker, such as Search. Does not change task identity.",
	);

export interface AgentToolDeps {
	taskManager?: AgentTaskManager;
	runner: Pick<SubAgentRunner, "run">;
	createRLMLoop: (route?: Readonly<ModelRoute>) => Pick<RLMLoop, "run">;
	maxDepth: number;
	workspaceManager?: Pick<WorkerWorkspaceManager, "runWorker" | "list">;
}

export interface DefaultToolDeps {
	client: AgentClient;
	config: Config;
	getTools?: () => readonly Tool[];
	hookController?: HookController;
	lsp?: LspService;
	skillController?: SkillActivator;
	getMcpRegistrar?: () => McpRegistrar | undefined;
	checkpoints?: CheckpointRecorder;
	workerWorkspaceManager?: WorkerWorkspaceManager;
	agentTaskManager?: AgentTaskManager;
}
