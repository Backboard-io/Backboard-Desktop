import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agentWait: PromptModule = definePrompt(
	`Join selected background workers by durable handle.

Call this after AgentSpawn when a worker's report is needed. Wait only for handles that block the next step; unrelated workers continue independently. Calling AgentWait again for an already-finished handle is safe and returns the same durable result. Use return_when="any" to resume when the first selected worker finishes; all (default) waits for every selected worker. A timeout returns current statuses without cancelling unfinished workers. On the next wait, select only pending handles so an already-finished worker does not trigger another immediate return.

completedCount and pendingHandles describe the selected set; failed or interrupted workers require explicit follow-up, not a success claim. A persistence error can accompany a captured result: do not rerun or reapply integrated work merely to repair bookkeeping.

Queued workers are still preparing their workspace and may fail before model execution. If preparation is unavailable, Agent and AgentSpawn will encounter the same backend limitation; change the stated prerequisite or continue permitted work directly instead of repeating the failed setup.

Do not issue AgentWait in the same assistant message as the AgentSpawn calls it joins. Wait for the spawn results first so the handles are registered.
`,
);
