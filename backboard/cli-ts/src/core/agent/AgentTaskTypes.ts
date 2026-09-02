import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";

export type AgentTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface AgentTaskResultBundle {
	data: AgentToolOutput;
	forLLM: string;
	title: string;
	detail?: string;
	completedAt: string;
}

export interface AgentTaskRecord {
	handle: string;
	sessionId: string;
	turnId?: string;
	prompt: string;
	readOnly: boolean;
	status: AgentTaskStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	result?: AgentTaskResultBundle;
	error?: string;
}

export const AGENT_TASK_STORE_VERSION = 1;

export interface AgentTaskStoreData {
	version: typeof AGENT_TASK_STORE_VERSION;
	tasks: AgentTaskRecord[];
}
