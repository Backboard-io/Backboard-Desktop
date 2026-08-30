import type { WorkerWorkspaceProgress } from "../workspaces/WorkerWorkspaceTypes.ts";

export type AgentMode = "worker" | "rlm";

export interface AgentToolOutput {
	mode: AgentMode;
	report: string;
	status: string;
	rounds: number;
	tracePath?: string;
	worker?: WorkerWorkspaceProgress;
}
