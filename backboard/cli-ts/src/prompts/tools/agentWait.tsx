import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agentWait: PromptModule = definePrompt(
	`Join selected background workers by durable handle.

Call this after AgentSpawn when a worker's report is needed. Wait only for handles that block the next step; unrelated workers continue independently. Calling AgentWait again for an already-finished handle is safe and returns the same durable result. A timeout returns current statuses without cancelling unfinished workers.

Do not issue AgentWait in the same assistant message as the AgentSpawn calls it joins. Wait for the spawn results first so the handles are registered.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`handles\` | \`string[]\` | yes | One to four AgentSpawn handles to join. |
| \`timeout_ms\` | \`number\` | no | Maximum wait before returning current statuses. |`,
);
