import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agentSpawn: PromptModule = definePrompt(
	`Start an isolated worker in the background and return a durable handle immediately.

Use this instead of Agent when useful parent work can continue before the worker result is needed. Spawn coarse, independent investigation or implementation with explicit non-overlapping file ownership. Writable workers are appropriate for separate components or tests; keep dependent edits and shared core files with one owner. For independent parallel workers, issue every AgentSpawn call in the same assistant message so model execution begins concurrently. Use read_only for research-only workers.

The prompt must contain the complete goal, repository context, constraints, ownership boundaries, acceptance criteria, and expected report. Integrated changes are already in the coordinator workspace; inspect them there instead of copying or reapplying private worktree changes. Workers cannot ask the user questions. Do not spawn recursively from a worker.

Keep every returned handle. A queued handle confirms durable registration while workspace preparation is pending; it does not mean the child model has started. Continue safe unrelated work, then call AgentWait in a later assistant message for the selected handles before depending on their output or giving the final answer. Agent and AgentSpawn use the same workspace backend: do not switch tool names or repeat an unavailable setup without fixing its stated prerequisite.
`,
);

export const agentSpawnBatch: PromptModule = {
	prompt: `Start one to four independent background workers in a single call. Prefer this over several AgentSpawn calls when assignments are known together. Give each worker a short name, a complete narrow assignment, and exclusive file ownership. Registration of the whole batch completes before new workers begin. Names are cosmetic; preserve returned handles and use AgentWait when their results are needed. Continue safe independent parent work while they run. A queued or preparing worker has not started its model. Completed model execution is not completed integration. Plain folders and dirty repositories are supported through private local snapshots; no GitHub connection or clean checkout is required. Do not initialize Git or alter user history for worker setup. Preserve reported conflicts and failures; do not repeat unchanged unavailable prerequisites.`,
};
export const agentCancel: PromptModule = {
	prompt: `Request cancellation of selected session-owned workers. Cancellation is cooperative and does not undo already captured or integrated changes. Use AgentWait to observe final outcomes; do not infer that the worker has stopped merely because this call returned.`,
};
