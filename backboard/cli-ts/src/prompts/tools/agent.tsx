import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agent: PromptModule = definePrompt(
	`Delegate work to an isolated sub-agent and block until its final report is ready. Use AgentSpawn instead when useful parent work can continue before the result is needed; join those workers later with AgentWait.

Optimize for wall-clock completion time, not agent count. Use direct file tools for ordinary coding, known changes across roughly 1-10 files, tightly coupled work, and edits to shared core files. Batch independent direct tool calls in the same assistant message instead of delegating them merely because several files are involved.

Always honor an explicit user request for sub-agents. Otherwise, delegate only when independent research or two to four coarse workstreams have clear non-overlapping ownership and their parallel model-time savings should exceed worker startup and integration overhead. Prefer read-only workers for independent investigation. If you delegate parallel work, issue every independent Agent call in the same assistant message.

The sub-agent cannot ask the user questions, so put the complete task and desired report shape in the prompt.

How to write a good prompt:
1. Goal:
2. Context (repo paths / commands / links):
3. Constraints (what to avoid / must preserve):
4. Questions to answer or steps to take:
5. Expected output format (e.g. file paths + summary, patch, checklist):

Usage notes:
1. If parallel sub-agents are the fastest eligible route, issue multiple Agent tool calls in the same assistant message instead of waiting for each result before spawning the next.
2. When the sub-agent is done, it returns a single message to you. The result is not shown to the user unless you summarize it.
3. Clearly tell the sub-agent whether you expect it to write code or only do research, and specify exactly what it should return.
4. Set \`read_only: true\` for research-only workers. The runtime enforces read-only tools and may start those workers while your response is still streaming. Leave it false or omit it when the worker must edit or run commands.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`subagent_type\` | \`string enum: worker, rlm\` | no | "worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL. For rlm, put all task detail in prompt, pass structured data through variables when useful, and finish with \`SUBMIT(answer)\`. |
| \`prompt\` | \`string\` | yes | The full delegated prompt, including all task detail, context, and report requirements. |
| \`read_only\` | \`boolean\` | no | Restrict a worker to non-mutating workspace tools. Use for parallel investigation that can begin while the parent response streams. |
| \`variables\` | \`object\` | no | Optional JSON object for rlm sub-agents. Values are available as \`inputs\`; valid non-reserved keys are also direct variables. Use this for file trees, selected file contents, examples, or constraints gathered by the parent. |
| \`timeout_ms\` | \`number\` | no | Optional wall-clock budget for rlm sub-agents. When the budget expires, the RLM returns a partial-progress report instead of continuing normal code execution. |`,
);
