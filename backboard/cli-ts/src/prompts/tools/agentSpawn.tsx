import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agentSpawn: PromptModule = definePrompt(
	`Start an isolated worker in the background and return a durable handle immediately.

Use this instead of Agent when useful parent work can continue before the worker result is needed. Only spawn coarse, independent work with clear ownership; direct tools remain faster for ordinary edits and shared core files. For independent parallel workers, issue every AgentSpawn call in the same assistant message so model execution begins concurrently. Use read_only for research-only workers.

The prompt must contain the complete goal, repository context, constraints, ownership boundaries, and expected report. Workers cannot ask the user questions. Do not spawn recursively from a worker.

Keep every returned handle. Continue safe unrelated work, then call AgentWait in a later assistant message for the selected handles before depending on their output or giving the final answer.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`prompt\` | \`string\` | yes | Complete delegated worker task. |
| \`read_only\` | \`boolean\` | no | Restrict the worker to non-mutating workspace tools. |`,
);
